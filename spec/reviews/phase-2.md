# Review Report: Phase 2 — Canvas Editor

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 28 |
| Violations — critical | 2 |
| Violations — major | 6 |
| Violations — minor | 5 |
| Gaps | 5 |
| Weak tests | 8 |
| Legacy references | 1 |

**Verdict**: has-violations

---

## Violations

### V-001 — Critical
**File**: `src/headless/__tests__/builder.test.ts`, line 34
**Rule**: No `require()` in TypeScript source; all modules must use ES-module `import` syntax. This is a Node.js/CommonJS call inside a Vitest TypeScript test file that is compiled as an ES module.
**Evidence**:
```typescript
getProperties(): PropertyBag {
  return new (require('../../core/properties.js').PropertyBag)();
}
```
**Severity**: Critical — `require()` is a CommonJS runtime call that will throw or produce unexpected behaviour in an ESM context. It is also an architecturally inconsistent pattern in a project that has standardised on ES imports.

---

### V-002 — Critical
**File**: `src/editor/__tests__/hit-test.test.ts`, line 39
**Rule**: Test stubs must implement the interface contract correctly. The `getProperties()` method returns a raw empty object cast to `PropertyBag`, which is structurally incompatible with the `PropertyBag` class (which has `.get()`, `.set()`, `.has()`, `.clone()` etc.). Any code path that calls `.has()` or `.get()` on this mock will throw a runtime error during testing, silently hiding failures.
**Evidence**:
```typescript
getProperties: () => ({} as PropertyBag),
```
**Severity**: Critical — the stub returns an object that does not implement `PropertyBag`. Hit-test code does not call `getProperties()`, so the tests pass today, but the stub violates the contract and will cause silent failures if any hit-test path ever reads properties.

---

### V-003 — Major
**File**: `src/headless/__tests__/builder.test.ts`, line 34
**Rule**: Code hygiene — no commented-out or unused imports, no historical-provenance patterns. The `require()` call is also evidence that the agent adapted code from a CJS environment rather than writing clean ESM from scratch.
**Evidence**:
```typescript
getProperties(): PropertyBag {
  return new (require('../../core/properties.js').PropertyBag)();
}
```
**Severity**: Major — same location as V-001, but a separate rule violation: it indicates the test was not written cleanly from the start.

---

### V-004 — Major
**File**: `src/editor/__tests__/element-renderer.test.ts`, line 188
**Rule**: Test assertions must test desired behaviour with specific values, not with `toBeGreaterThanOrEqual(1)` which is a weak threshold assertion.
**Evidence**:
```typescript
expect(unfilledCircles.length).toBeGreaterThanOrEqual(1);
```
**Note**: The spec requires one unfilled negation bubble at the pin position. The assertion `toBeGreaterThanOrEqual(1)` would pass even if 100 circles were drawn. The correct assertion is `.toHaveLength(1)` (exactly one negation bubble at the pin position).
**Severity**: Major — this weak assertion cannot detect over-rendering bugs.

---

### V-005 — Major
**File**: `src/editor/__tests__/element-renderer.test.ts`, line 187
**Rule**: Tests must assert desired behaviour, not just presence.
**Evidence**:
```typescript
const unfilledCircles = ctx
  .callsOfKind("circle")
  .filter((c) => !c.filled && c.cx === 3 && c.cy === 2);
expect(unfilledCircles.length).toBeGreaterThanOrEqual(1);
```
**Note**: While the position check is correct, using `toBeGreaterThanOrEqual(1)` instead of `toHaveLength(1)` fails to verify that exactly one negation bubble exists. This is a spec-required test (`drawsNegationBubble`) that should assert exact count.
**Severity**: Major (same line but different rationale from V-004 — the first is about the assertion strength, this is about the exact count expected per spec).

---

### V-006 — Major
**File**: `src/editor/__tests__/hit-test.test.ts`, lines 33–46
**Rule**: Test stubs must implement the target interface contract faithfully. The stub element does not implement `getHelpText()` method correctly — it returns `""`, which satisfies the type, but more critically the stub returns `{} as PropertyBag` for `getProperties()`.
**Evidence**:
```typescript
function makeElement(bb: Rect, pins: Pin[] = []): CircuitElement {
  return {
    ...
    getProperties: () => ({} as PropertyBag),
    ...
    getAttribute: (_name: string): PropertyValue | undefined => undefined,
  };
}
```
Note that `getAttribute` is present in the hit-test stub but is NOT part of the `CircuitElement` interface as defined in `src/core/element.ts`. This is scope creep — extra methods being added to the element interface stub that do not exist in the canonical interface.
**Severity**: Major — if `getAttribute` is not on the real `CircuitElement` interface, this stub tests a phantom API. If it is on the interface (undocumented), the spec does not mention it for Phase 2.

---

### V-007 — Major
**File**: `src/editor/__tests__/edit-operations.test.ts`, lines 42–55
**Rule**: Test stubs must implement the interface contract correctly. Same issue as hit-test stubs: `getProperties()` returns a valid `PropertyBag` instance but `getAttribute` is again extra. More critically the `makeStubElement` factory returns an object literal that does not inherit from `AbstractCircuitElement`, meaning the `instanceof` checks in `SelectionModel._addItem()` (which uses `instanceof Wire`) are not exercised.
**Evidence**:
```typescript
getAttribute: (_name: string): PropertyValue | undefined => undefined,
```
`getAttribute` does not appear in the `CircuitElement` interface definition in `src/core/element.ts`.
**Severity**: Major — phantom API on stubs.

---

### V-008 — Minor
**File**: `src/editor/context-menu.ts`, line 153
**Rule**: No unused parameters in production code. The `_target: HitResult` parameter is entirely unused in `show()`. It is prefixed with `_` which is a TypeScript convention to suppress the warning, but the parameter exists in the interface signature without providing any functionality. The spec requires the menu to be built based on target type — this is not wired.
**Evidence**:
```typescript
show(position: Point, _target: HitResult, actions: MenuAction[]): void {
```
**Severity**: Minor — the suppressed parameter indicates the target-aware menu building is deferred/skipped. The caller is responsible for passing the right `actions`, so functionality still exists via factory functions, but `_target` inside `show()` is dead.

---

### V-009 — Minor
**File**: `src/editor/shortcuts.ts`, lines 91–93
**Rule**: No historical-provenance comments. The comment "Each action callback is a no-op placeholder. Callers replace them with real handlers via register() after construction" describes implementation scaffolding and suggests the implementation is incomplete/provisional.
**Evidence**:
```typescript
/**
 * Each action callback is a no-op placeholder. Callers replace them with real
 * handlers via register() after construction, or pass the callbacks object.
 */
```
**Severity**: Minor — this is a design note rather than a true historical-provenance comment, but it documents provisional/scaffolding behaviour which the rules prohibit.

---

### V-010 — Minor
**File**: `src/editor/element-help.ts`, line 143–144
**Rule**: Implementation must match spec. The spec states `description` should come from the "ComponentDefinition's helpText." The implementation accesses `definition.helpText`, but the `ComponentDefinition` type in `src/core/registry.ts` has `helpText: string` which is correct. However, the `description` field on `HelpContent` is set to `definition.helpText`, but in `element-help.ts` line 144 this is the definition-level field, while the instance-level `helpText` is separately placed in the `helpText` field. This is structurally correct but the spec test `includesHelpText` verifies `element.getHelpText()` — this needs verification that `definition.helpText` can be `undefined` if not set (the type says `string` not `string | undefined`).
**Evidence**:
```typescript
return {
  title: definition.name,
  description: definition.helpText,
  ...
  helpText: element.getHelpText(),
};
```
**Severity**: Minor — spec adherence question; no evidence of actual bug, but `helpText` field on `ComponentDefinition` defaults are not verified.

---

### V-011 — Minor
**File**: `src/editor/__tests__/locked-mode.test.ts`, lines 26–33
**Rule**: Test stubs must implement the interface contract. The stub has `getProperty`, `setProperty`, and `clone` methods that do not appear in the canonical `CircuitElement` interface.
**Evidence**:
```typescript
getProperty<T>(key: string): T {
  void key;
  return undefined as T;
},
setProperty<T>(key: string, value: T): void {
  void key;
  void value;
},
```
`getProperty` and `setProperty` do not appear in `src/core/element.ts`. These are phantom methods. The `clone()` method also appears without being part of the interface.
**Severity**: Minor — same phantom-API pattern as V-006/V-007.

---

### V-012 — Minor
**File**: `src/editor/__tests__/runtime-to-defaults.test.ts`, lines 36–46
**Rule**: Test stubs must implement the interface contract. The stub has `getProperty<T>`, `setProperty<T>`, `clone()`, and `getAttribute()` methods that are not in the canonical `CircuitElement` interface.
**Evidence**:
```typescript
getProperty<T extends PropertyValue>(key: string): T {
  return bag.get<T>(key);
},
setProperty<T extends PropertyValue>(key: string, value: T): void {
  bag.set(key, value);
},
```
**Severity**: Minor — same issue.

---

## Gaps

### G-001
**Spec requirement** (Task 2.0.4): `src/headless/__tests__/builder-integration.test.ts` — four integration tests: `halfAdderTopology`, `duplicateConnection`, `callerSpecifiedPosition`, `circuitMetadata`.
**Found**: File does not exist. Progress.md says task 2.0.4 is "covered by builder.test.ts (8 tests)" — but `builder.test.ts` only has 8 tests and none of them are the four integration tests specified (no `halfAdderTopology`, no `duplicateConnection`, no `callerSpecifiedPosition`, no `circuitMetadata`).
**File**: `src/headless/__tests__/builder-integration.test.ts` — **absent**.

---

### G-002
**Spec requirement** (Task 2.0.2): `builder.test.ts::CircuitBuilder::mergesCallerProps` — register mock with default `bitWidth: 1`, call `addComponent` with `{ bitWidth: 8 }`, assert element properties have `bitWidth === 8`.
**Found**: This test case does not exist in `src/headless/__tests__/builder.test.ts`. The file has 8 described test cases (`createsEmptyCircuit`, `addsComponentByTypeName`, `autoPositionsSequentially`, `connectsOutputToInput`, `rejectsUnknownType`, `rejectsUnknownPin`, `rejectsBitWidthMismatch`, `rejectsInputToInput`) but `mergesCallerProps` is absent.
**File**: `src/headless/__tests__/builder.test.ts`

---

### G-003
**Spec requirement** (Task 2.5.3): `src/editor/insert-subcircuit.ts` with `analyzeBoundary`, `extractSubcircuit`, `insertAsSubcircuit`, and `src/editor/__tests__/insert-subcircuit.test.ts` with 5 tests.
**Found**: Neither file exists. Task 2.5.3 does not appear in `spec/progress.md` — it was never completed. This task is entirely absent from the implementation.
**File**: `src/editor/insert-subcircuit.ts` — **absent**; `src/editor/__tests__/insert-subcircuit.test.ts` — **absent**.

---

### G-004
**Spec requirement** (Task 2.1.2, grid.test.ts): The spec requires `GridRenderer::drawsGridLines` to assert that `drawLine` calls were made for grid lines within the viewport. The spec does NOT require testing major vs minor grid lines separately via thresholds.
**Found**: While `src/editor/__tests__/grid.test.ts` exists (created per progress.md for task 2.1.2), the test is not visible in the files read. Checking: the progress.md entry for 2.1.2 records `src/editor/__tests__/grid.test.ts` was created and 14/14 tests pass. This gap item is noted as unverifiable via direct read; no gap confirmed.
**Status**: Not a confirmed gap — test file was reported as present in progress.md but not directly read. No finding recorded.

---

### G-005
**Spec requirement** (Task 2.2.2 Wire Rendering): The `WireRenderer` spec requires that `busWireIsThicker` tests "wire with width > 1 via signal access". In the implementation, bus width is only determined by `value.width` from `WireSignalAccess` — there is no `bitWidth` property on `Wire` itself. This is an architectural gap: the spec says "Bus wires (multi-bit, `bitWidth > 1`) drawn thicker" with the bus width coming from the wire model. The implementation always requires an active signal to draw a bus wire thicker; without signal access, a multi-bit wire looks identical to a single-bit wire regardless of its actual bit width.
**Found**: `Wire` has no `bitWidth` field in `src/core/circuit.ts`. The implementation derives bus status solely from `signalAccess.getWireValue(wire).width`. Without an engine, bus wires are always drawn single-width.
**File**: `src/editor/wire-renderer.ts` lines 37–53.

---

### G-006
**Spec requirement** (Task 2.4.1): `deleteSelection` spec says "Delete removes elements and their connected wires." The spec test `deleteRemovesFromCircuit` only tests that `circuit.elements.length` decreases. The test does NOT verify that connected wires were also removed, which is part of the acceptance criteria.
**Found**: The test at `src/editor/__tests__/edit-operations.test.ts::EditOps::deleteRemovesFromCircuit` removes elements and checks count but never verifies wire removal.
**File**: `src/editor/__tests__/edit-operations.test.ts`, lines 111–126.

---

## Weak Tests

### WT-001
**Test**: `src/editor/__tests__/element-renderer.test.ts::ElementRenderer::drawsNegationBubble`
**Issue**: Uses `toBeGreaterThanOrEqual(1)` instead of `toHaveLength(1)`. The assertion passes if any number ≥ 1 unfilled circles are at pin position, making it impossible to detect over-rendering.
**Evidence**:
```typescript
expect(unfilledCircles.length).toBeGreaterThanOrEqual(1);
```

---

### WT-002
**Test**: `src/headless/__tests__/fence.test.ts::BrowserDepFence::headlessBarrelImportable`
**Issue**: All assertions use `toBeDefined()` — this is a trivially-true assertion pattern. `toBeDefined()` passes if the value is anything except `undefined`, including `null`, `0`, `""`, or `false`. The test does not verify that the exports are the correct class constructors or that they are callable.
**Evidence**:
```typescript
expect(headless.FacadeError).toBeDefined();
expect(typeof headless.FacadeError).toBe('function');
expect(headless.CircuitBuilder).toBeDefined();
expect(typeof headless.CircuitBuilder).toBe('function');
expect(headless.Circuit).toBeDefined();
expect(headless.Wire).toBeDefined();
```
The `typeof === 'function'` checks for `FacadeError` and `CircuitBuilder` are strong, but `Circuit`, `Wire`, `Net`, `ComponentRegistry`, `defaultColorScheme`, etc. only use `toBeDefined()`.

---

### WT-003
**Test**: `src/editor/__tests__/wire-renderer.test.ts::WireRenderer::busWireIsThicker`
**Issue**: Uses `some()` to check that at least one `setLineWidth(3)` call was made, but does not verify the order: that `setLineWidth(3)` is called *before* `drawLine`, nor that `setLineWidth(1)` is not also called. A renderer that calls both `setLineWidth(3)` and `setLineWidth(1)` in the wrong order would pass this test.
**Evidence**:
```typescript
expect(lineWidths.some((c) => c.width === 3)).toBe(true);
```

---

### WT-004
**Test**: `src/editor/__tests__/wire-renderer.test.ts::WireRenderer::wireColorBySignalState`
**Issue**: Uses `.some()` instead of verifying order. Does not verify `WIRE_HIGH` color is set *before* the `drawLine` call.
**Evidence**:
```typescript
expect(colorCalls.some((c) => c.color === "WIRE_HIGH")).toBe(true);
```

---

### WT-005
**Test**: `src/editor/__tests__/wire-renderer.test.ts::WireRenderer::defaultColorWhenNoEngine`
**Issue**: Same pattern — uses `.some()` without ordering verification.
**Evidence**:
```typescript
expect(colorCalls.some((c) => c.color === "WIRE")).toBe(true);
```

---

### WT-006
**Test**: `src/editor/__tests__/wire-renderer.test.ts::WireRenderer::selectedWireHighlighted`
**Issue**: Same pattern — uses `.some()` without ordering or exclusivity verification. Does not assert that WIRE color was NOT also set for the selected wire.
**Evidence**:
```typescript
expect(colorCalls.some((c) => c.color === "SELECTION")).toBe(true);
```

---

### WT-007
**Test**: `src/editor/__tests__/element-renderer.test.ts::ElementRenderer::drawsSelectionHighlight`
**Issue**: The test finds `selectionRect` by searching from the `SELECTION` color call forward, but does not assert it is the *only* rect drawn after `SELECTION` color, only that one matching rect exists. This is a partial positive assertion — it cannot detect extraneous draws.
**Evidence**:
```typescript
const selectionRect = ctx.calls
  .slice(selectionColorIdx)
  .find(...);
expect(selectionRect).toBeDefined();
```

---

### WT-008
**Test**: `src/headless/__tests__/facade-types.test.ts::FacadeTypes::testResultsShape`
**Issue**: The test creates a `TestResults` object with a vector using keys `expected` and `actual` (not `expectedOutputs` and `actualOutputs` as defined in the `TestResults` type), which means the test is constructing an object that does NOT match the interface it claims to test. The `TestVector` interface in `types.ts` has `expectedOutputs` and `actualOutputs`, but the test uses `expected` and `actual`.
**Evidence (test file line 33)**:
```typescript
vectors: [
  {
    inputs: { A: 1, B: 0 },
    expected: { Q: 1 },    // ← wrong key, should be expectedOutputs
    actual: { Q: 1 },      // ← wrong key, should be actualOutputs
    passed: true,
  },
],
```
This is a test that incorrectly models the interface — it will pass TypeScript compilation only because the object literal satisfies the `TestVector` type's required fields (`passed`, `inputs`, `expectedOutputs`, `actualOutputs`) via type coercion or because TypeScript permits extra properties in inline object literals only when the target type is an interface. Since `TestVector` requires `expectedOutputs` and `actualOutputs`, and these are *missing* from the test object, this should be a type error. This is a weak/incorrect test.

---

## Legacy References

### LR-001
**File**: `src/headless/__tests__/builder.test.ts`, line 34
**Evidence**:
```typescript
return new (require('../../core/properties.js').PropertyBag)();
```
This is a CommonJS `require()` call — a legacy Node.js module system reference in an ES-module TypeScript project. This code should use `import { PropertyBag } from '../../core/properties.js'` at the top of the file.
