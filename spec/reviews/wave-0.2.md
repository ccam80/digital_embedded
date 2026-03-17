# Review Report: Wave 0.2 — Runner + Mode Integration

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 2 (0.2.1, 0.2.2) |
| Violations | 6 |
| Gaps | 1 |
| Weak tests | 1 |
| Legacy references | 1 |
| **Verdict** | **has-violations** |

---

## Violations

### V1 — Historical-provenance comment (critical)
**File**: `src/analog/compiler.ts`, lines 2–6
**Rule**: No historical-provenance comments. Comments describing what code replaced, what it used to do, or where it is going are banned.
**Evidence**:
```
 * Analog circuit compiler — stub.
 *
 * Delivered in Phase 1. This module exists so that the runner can reference
 * the compile path without a runtime dependency on Phase 1 implementation.
```
The phrase "Delivered in Phase 1" describes future delivery intent — a forward-provenance comment that is banned by the same rule. The phrase "This module exists so that the runner can reference the compile path without a runtime dependency on Phase 1 implementation" describes why the stub exists relative to a future phase. Both sentences are historical/forward-provenance commentary.
**Severity**: critical

---

### V2 — Historical-provenance comment (critical)
**File**: `src/analog/compiler.ts`, lines 15–16
**Rule**: No historical-provenance comments.
**Evidence**:
```
 * Phase 1 (Task 1.2) delivers this implementation. Until then, calling this
 * function throws to make the unimplemented path visible at runtime.
```
This comment describes what the code is a placeholder for and what a future phase will do — banned forward-provenance. The comment also makes the violation intentional by explaining the shortcut.
**Severity**: critical

---

### V3 — Historical-provenance comment (critical)
**File**: `src/analog/element.ts`, lines 2–5
**Rule**: No historical-provenance comments.
**Evidence**:
```
 * Analog element interface — stub for Phase 1.
 *
 * Phase 1 (Task 1.2.2) will replace this with the full implementation.
 * This file exists so that the type-only import in registry.ts resolves.
```
Three separate violations: "stub for Phase 1" labels the file as a placeholder for a future phase; "Phase 1 (Task 1.2.2) will replace this with the full implementation" explicitly describes what replaces this file; "This file exists so that the type-only import in registry.ts resolves" is a provenance explanation for the file's existence. All three are banned.
**Severity**: critical

---

### V4 — Functional defect in setInput analog path (critical)
**File**: `src/headless/runner.ts`, line 192
**Rule**: No fallbacks. Code must implement the specified behaviour correctly.
**Spec requirement** (Task 0.2.1): "`setInput()`: for analog engines, resolve label via `compiled.labelToNodeId`, set voltage"
**Evidence**:
```typescript
record.engine.getNodeVoltage(nodeId);
return;
```
The implementation calls `getNodeVoltage()` — a read — instead of any voltage-setting operation. The return value is discarded. The method does nothing: it reads and throws the result away. The spec requires setting the voltage. This is a wrong implementation masquerading as a stub.
**Severity**: critical

---

### V5 — Analog compile path uses illegal double-cast instead of engine factory (major)
**File**: `src/headless/runner.ts`, lines 87–89
**Rule**: No fallbacks, no safety wrappers. Code must implement the specified behaviour.
**Spec requirement** (Task 0.2.1): "create an analog engine via factory"
**Evidence**:
```typescript
const engine = compiled as unknown as AnalogEngine;
this._records.set(engine, { engineType: "analog", engine, compiled });
return engine as unknown as SimulationEngine;
```
Because `compileAnalogCircuit` throws unconditionally, these lines are unreachable. However, they are still present in the compiled source and contain double `as unknown as` casts that treat a `CompiledAnalogCircuit` as if it were an `AnalogEngine` — these types are structurally incompatible. The spec requires creating an engine via factory. What is here is a fabricated placeholder that would be functionally wrong if the compiler stub were replaced. This is not an engine factory; it is a cast that happens to be dead code.
**Severity**: major

---

### V6 — Oscillation executeFn in test bypasses wiringTable (minor)
**File**: `src/headless/__tests__/runner.test.ts`, line 380
**Rule**: Tests must assert desired behaviour (no implementation-detail shortcuts that break the established execution contract).
**Evidence**:
```typescript
executeFn: (_index: number, state: Uint32Array, __highZs: Uint32Array, layout: ComponentLayout) => {
  toggle = toggle === 0 ? 1 : 0;
  state[layout.outputOffset(_index)] = toggle;
},
```
All other executeFns in the codebase (including in this very file at lines 95–97 and 105–107) access state via `state[layout.wiringTable[layout.outputOffset(index)]]`. This inline test executeFn skips the wiringTable indirection, writing directly to `state[layout.outputOffset(_index)]`. The output will land at a wiring-table index, not the resolved net ID, producing incorrect results. The test happens to pass because the oscillation test only checks that an `OscillationError` is thrown (not the signal values), but the executeFn is incorrect.
**Severity**: minor

---

## Gaps

### G1 — `compile()` returns `SimulationEngine` but accepts analog path returning wrong type
**Spec requirement** (Task 0.2.1): "`compile()`: read `circuit.metadata.engineType`; when `"analog"`, call `compileAnalogCircuit()` (stub) and create an analog engine via factory"
**What was found**: `compile()` is typed to return `SimulationEngine`. The analog path would have to return a value typed `SimulationEngine`, forcing the double-cast at lines 88–89. The spec does not specify what `compile()` returns in the analog case, but the return type of `SimulationEngine` is inconsistent with the `EngineRecord` union which stores an `AnalogEngine` separately. The method signature forces an incorrect type narrowing that will need to be undone in Phase 1.
**File**: `src/headless/runner.ts`, line 84

---

## Weak Tests

### WT1 — mode-toggle tests test extracted helper functions, not app-init.ts wiring
**Test**: `src/app/__tests__/mode-toggle.test.ts::ModeToggle` (all four tests)
**What is wrong**: The test file defines `toggleMode()` and `applyEngineTypeFromCircuit()` as local helper functions that replicate the logic from `app-init.ts`. The tests exercise these helpers, not the actual event handler code at lines 2998–3006 of `app-init.ts`. This means the tests would pass even if the event handler in `app-init.ts` were entirely absent or broken. The spec requires verifying the behaviour of the toggle — which is in `app-init.ts` — not a copy of the logic in a test file.
**Evidence**:
```typescript
function toggleMode(circuit: Circuit, palette: ComponentPalette): void {
  const current = circuit.metadata.engineType;
  const next = current === 'digital' ? 'analog' : 'digital';
  circuit.metadata = { ...circuit.metadata, engineType: next };
  palette.setEngineTypeFilter(next === 'digital' ? null : 'analog');
}
```
The spec acceptance criterion "Edit menu shows current circuit mode with a checkmark or label" and "Toggling changes palette to show only components matching the engine type" cannot be verified by tests that don't touch the DOM element binding or the app-init event handler.

---

## Legacy References

### LR1 — "legacy" in a file-format comment
**File**: `src/app/app-init.ts`, line 1997
**Evidence**:
```typescript
// JSON — distinguish .digb format from legacy .digj
```
The word "legacy" is used to describe an old file format (`.digj`). This is not a historical-provenance comment about code changes, but the rules flag this word explicitly. Reported for completeness; the user should determine whether this pre-dates Wave 0.2 or was introduced by it.

---

## Scope Notes

- Task 0.2.2 specifies 3 tests; the implementation delivers 4 (`load_digital_circuit_keeps_null_filter` is additional). This is minor scope creep but not a violation of a hard rule.
- The `src/analog/element.ts` file is listed in the wave completion report as a Wave 0.2 delivery. Per `spec/progress.md`, it was specified by Task 0.1.2 (Wave 0.1). It was either created in Wave 0.1 and listed again, or created for the first time in Wave 0.2. Either way it is present; no gap in its existence. The historical-provenance violations in it are still violations regardless of which wave created it.
