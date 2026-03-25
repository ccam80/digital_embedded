# Review Report: Phase 5 — Simplify Consumers

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 5 (P5-1, P5-2, P5-3, P5-4, P5-5) |
| Violations — critical | 0 |
| Violations — major | 3 |
| Violations — minor | 3 |
| Gaps | 3 |
| Weak tests | 2 |
| Legacy references | 4 |

**Verdict**: has-violations

---

## Violations

### V1 — Historical-provenance comment in runner.ts (major)

**File**: `src/headless/runner.ts`, line 69
**Rule violated**: Code Hygiene — "No historical-provenance comments. Any comment describing what code replaced, what it used to do, why it changed, or where it came from is banned."
**Evidence**:
```
// creates a DefaultSimulationCoordinator, and returns the underlying digital or analog
// backend engine for backward-compatible stepping.
```
The phrase "backward-compatible stepping" describes what the return value is for in terms of historical API continuity — a provenance comment explaining what the old interface was. This is not an explanation of how complicated code works; it is a description of why the return type was preserved from an older design.

**Severity**: major

---

### V2 — Historical-provenance comment in dig-loader.ts (major)

**File**: `src/io/dig-loader.ts`, lines 350–352
**Rule violated**: Code Hygiene — historical-provenance comment ban.
**Evidence**:
```typescript
// engineType is read from .dig XML for backward compatibility but is
// not stored on CircuitMetadata — the unified compiler derives the
// simulation domain from component models.
```
This comment explicitly describes what the code _replaced_ ("not stored on CircuitMetadata"), why it changed ("unified compiler derives the domain from component models"), and uses the banned phrase "backward compatibility". Even if the loader compat behaviour is permitted by the spec (P5-2 step 3), a comment explaining the historical reason for the code's existence violates the historical-provenance comment ban.

**Severity**: major

---

### V3 — Backward-compat comment in load.ts (minor)

**File**: `src/io/load.ts`, line 44
**Rule violated**: Code Hygiene — historical-provenance comment ban.
**Evidence**:
```typescript
engineType: z.string().optional(), // retained for backward-compat deserialization only
```
The inline comment uses the banned phrase "retained for backward-compat" and describes why the field exists historically. The code itself is acceptable (the spec explicitly permits loader/save to retain for file compat); the comment is the violation.

**Severity**: minor

---

### V4 — Property key mismatch: `"simulationMode"` used where spec requires `"simulationModel"` (major)

**File**: `src/editor/property-panel.ts`, lines 169–202
**Rule violated**: Spec adherence — P5-4 acceptance criterion specifies the property key as `"simulationModel"`.
**Evidence**:
The spec states: "Property stored in component's PropertyBag as key `'simulationModel'`". The implementation consistently uses the key `"simulationMode"`:
```typescript
const current = bag.has("simulationMode")
  ? (bag.get("simulationMode") as string)
  : defaultMode;
// ...
bag.set("simulationMode", newMode);
// ...
this._inputs.set("simulationMode", { ... });
```
This key mismatch means the compiler's `extractConnectivity.ts` (which reads `getAttribute('simulationModel')`) will never receive the value set by the property panel — the two systems use different keys. The feature is broken by construction.

**Severity**: major

---

### V5 — `void circuit` suppresses unused-parameter warning instead of removing the parameter (minor)

**File**: `src/integration/editor-binding.ts`, line 103
**Rule violated**: Code Hygiene — no workarounds / suppression tricks.
**Evidence**:
```typescript
bind(
  circuit: Circuit,
  coordinator: SimulationCoordinator,
  wireSignalMap: Map<Wire, SignalAddress>,
  pinSignalMap: Map<string, SignalAddress>,
): void {
  void circuit;
  ...
}
```
The `circuit` parameter is accepted in the interface but is unused in the implementation. The `void circuit` statement is a TypeScript no-op trick to suppress the unused-variable lint warning. The parameter was kept because the interface declares it, but the correct approach is either to use it (as the interface implies it should be available for context), or to remove it from both the interface and the implementation if it serves no purpose. The `void` expression is a code-quality workaround.

**Severity**: minor

---

### V6 — `toBeCloseTo` used for analog voltage assertion (minor)

**File**: `src/integration/__tests__/editor-binding.test.ts`, line 111
**Rule violated**: Testing rules — "Test the specific: exact values, exact types." The `toBeCloseTo` matcher is an approximation assertion. The value `3.3` is an exact float literal injected by the test itself; there is no imprecision source. The assertion `expect(value).toBeCloseTo(3.3)` should be `expect(value).toBe(3.3)`.
**Evidence**:
```typescript
coordinator.setSignal(analogAddr, { type: "analog", voltage: 3.3 });
// ...
expect(value).toBeCloseTo(3.3);
```
The coordinator is a mock that returns exactly `3.3`. The `signalToNumber` function returns `sv.voltage` directly. There is no floating-point arithmetic between injection and assertion. `toBeCloseTo` here serves to paper over a test the author was uncertain would pass exactly.

**Severity**: minor

---

## Gaps

### G1 — P5-3 acceptance criterion: render loop not unified

**Spec requirement (P5-3, step 4)**: "Unify render loop — remove separate `startAnalogRenderLoop` vs `startContinuousRun`. One loop that calls `coordinator.step()`."

**Spec acceptance (P5-3)**: "All analog/digital features still work (guarded by backend null checks, not mode flags)"

**What was found**: Both `startAnalogRenderLoop` and `startContinuousRun` remain as separate functions. The `btn-run` handler still explicitly branches:
```typescript
if (analogCompiled !== null && eng) {
  // ...
  startAnalogRenderLoop(eng as ..., circuit, analogCompiled);
  return;
}
// ...
startContinuousRun();
```
These are separate animation loop functions with different internal logic, not unified via `coordinator.step()`. The spec's "one render loop" requirement is not implemented.

**File**: `src/app/app-init.ts`, lines 2217–2233, 1954–1993, 2014–2073

---

### G2 — P5-3 acceptance criterion: step button does not call `coordinator.step()`

**Spec requirement (P5-3, step 5)**: "Unify step button — `coordinator.step()`, with `coordinator.digitalBackend?.microStep()` for micro-step mode."

**What was found**: The step button handler calls `facade.step(eng)`, not `coordinator.step()`. The spec requires the step to go through the coordinator interface:
```typescript
// btn-step handler (line 2196–2213)
if (facade.getCoordinator()?.analogBackend !== null) {
  facade.step(eng);   // ← should be coordinator.step()
} else {
  facade.step(eng);   // ← should be coordinator.step()
}
```
Similarly, the micro-step handler checks `facade.getCoordinator()?.analogBackend !== null` for branching (correct direction) but calls `(eng as unknown as { microStep(): void }).microStep()` rather than `coordinator.digitalBackend?.microStep()` as the spec prescribes.

**File**: `src/app/app-init.ts`, lines 2192–2267

---

### G3 — P5-4 property key mismatch disconnects panel from compiler

**Spec requirement (P5-4)**: "Property stored in component's PropertyBag as key `'simulationModel'`"

**What was found**: The property panel stores the value under key `"simulationMode"`, but `src/compile/extract-connectivity.ts` reads `el.getAttribute('simulationModel')` (line 82). As a result, changes made via the dropdown are never picked up by the compiler. The dropdown renders and fires callbacks, but the model selection has no effect on compilation. This is a silent functional regression — tests pass because they only verify the panel's internal bag, not that the compiler reads the value.

**File**: `src/editor/property-panel.ts`, lines 169, 190, 198; cross-reference `src/compile/extract-connectivity.ts`, line 82.

---

## Weak Tests

### WT1 — `engine accessor` test asserts null unconditionally

**Test path**: `src/integration/__tests__/editor-binding.test.ts::EditorBinding::engine accessor — returns digitalBackend from coordinator when bound`

**What is wrong**: The test description says "returns digitalBackend from coordinator when bound", but the assertion is `expect(binding.engine).toBeNull()`. The test binds a `MockCoordinator` whose `_digitalBackend` is null by default. The test never exercises the non-null path — it only asserts the trivially-true default state. A backend-returning case (where `MockCoordinator.setDigitalBackend()` is called) is never tested.

**Evidence**:
```typescript
it("engine accessor — returns digitalBackend from coordinator when bound", () => {
  binding.bind(circuit, coordinator, wireSignalMap, pinSignalMap);
  expect(binding.engine).toBeNull();  // always null — default mock state
});
```

---

### WT2 — `simulationModeDropdown_multiModelShowsDropdown` asserts `toBeDefined()` without value check

**Test path**: `src/editor/__tests__/property-panel.test.ts::PropertyPanel::simulationModeDropdown_multiModelShowsDropdown`

**What is wrong**: The test only verifies that the `simulationMode` input is registered (non-undefined) and that one row was added. It does not check the initial value of the dropdown, which is the key behaviour for this specific test. A correct implementation that registers the input with a wrong default value would pass this test.

**Evidence**:
```typescript
expect(panel.getInput("simulationMode")).toBeDefined();
```
No assertion on the initial value. Compare with `simulationModeDropdown_usesDefaultModel` which does check value — that coverage is only present in a separate test, leaving this test's "shows dropdown" description incomplete as a behaviour test.

---

## Legacy References

### LR1 — `"backward compatibility"` comment in dig-loader.ts (same as V2)

**File**: `src/io/dig-loader.ts`, line 350
**Evidence**: `// engineType is read from .dig XML for backward compatibility but is`
This is both a rule violation (V2) and a legacy reference. The comment explicitly names the stale API (`engineType`) and gives the historical reason for its continued presence.

---

### LR2 — `"backward-compat"` comment in load.ts (same as V3)

**File**: `src/io/load.ts`, line 44
**Evidence**: `// retained for backward-compat deserialization only`
Inline comment on the Zod schema field retaining the stale `engineType` key references the old deserialization contract.

---

### LR3 — `"backward-compatible stepping"` comment in runner.ts (same as V1)

**File**: `src/headless/runner.ts`, line 69
**Evidence**: `// backend engine for backward-compatible stepping.`
The JSDoc for `compile()` names the return type's existence as backward-compatible with the pre-coordinator API.

---

### LR4 — `"legacy"` comment in app-init.ts

**File**: `src/app/app-init.ts`, line 2697
**Evidence**: `// Also remove any legacy wire-context-menu still in the DOM`
The word "legacy" describes a DOM element by its historical provenance. This is a historical-provenance comment: it says the element exists because of prior code. Whether this is a Phase 5 change or pre-existing cannot be determined from progress.md (it is not in the Phase 5 file-change lists), but it is present in a file modified by P5-3 and must be flagged.

---

## Notes

1. The `it.skip` occurrences in `src/fixtures/__tests__/shape-audit.test.ts` and `src/fixtures/__tests__/fixture-audit.test.ts` are conditional guards executed only when no fixture files exist (dynamic describe block), not static test skips. They are not rule violations.

2. The `engineType` field in `src/io/save-schema.ts` (line 25, JSDoc comment `"Absent in older files; defaults to 'digital'"`) is a description of the schema, not a banned comment, but references the historical default value. This is borderline; it is not flagged as a violation but is noted here for the fixer's attention.

3. The `"backward compat"` comment in `src/components/wiring/splitter.ts` (line 103) and the `"backward-compatible default"` in `src/editor/palette.ts` (line 158) are in files that were **not** modified by Phase 5 tasks. They are noted as pre-existing and are out of scope for this review.

4. The `simulationMode` vs `simulationModel` key mismatch (V4 / G3) is the most consequential finding: the property panel's dropdown silently stores its value under a key the compiler never reads, making the entire P5-4 feature non-functional in production despite all tests passing.
