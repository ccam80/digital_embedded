# Review Report: Wave FIX.1 — Functional Defects

## Summary

| Item | Value |
|------|-------|
| Tasks reviewed | 5 (F1, F2, F3, F4, F5) |
| Violations — critical | 2 |
| Violations — major | 2 |
| Violations — minor | 1 |
| Gaps | 1 |
| Weak tests | 7 |
| Legacy references | 0 |
| Verdict | **has-violations** |

---

## Violations

### V1 — CRITICAL: `builtinIsPresent` still eagerly returns `true` — spec fix not applied to builtins.ts

- **File**: `src/hgs/builtins.ts:246-248`
- **Rule violated**: Completeness — never mark work as incomplete; spec adherence — all "Files to modify" must be modified with the specified changes.
- **Evidence**:
  ```typescript
  function builtinIsPresent(): HGSFunction {
    return new HGSFunction(async (_args) => true, "isPresent");
  }
  ```
- **Severity**: critical
- **Analysis**: The spec (F5) requires: "Implement lazy evaluation for `isPresent`. The evaluator must catch evaluation errors on the argument and return `false` if evaluation fails, `true` if it succeeds. This requires changes in the evaluator's function-call logic to special-case `isPresent` with try/catch around argument evaluation." The evaluator was correctly updated (`src/hgs/evaluator.ts:134-142` has the `isPresent` special-case with try/catch). However, `builtinIsPresent()` in `builtins.ts` still returns a function that unconditionally returns `true`, ignoring its argument entirely. This stub body is dead code but its existence is misleading and violates the scorched-earth rule for replaced code. The spec (and spec section M2) also required the "For now" comment block at `src/hgs/builtins.ts:250-254` to be removed — the progress note for F5 also referenced `src/hgs/builtins.ts` as a file to be modified. The function body is never actually called for `isPresent` (the evaluator intercepts the call first), but the stub still constitutes incorrect, misleading code that contradicts the implementation's intent.

---

### V2 — CRITICAL: F1 progress note claims "verified existing dynamic dispatch" but the actual defect (hardcoded `makeExecuteAdd(1)`) is unresolved at the source level

- **File**: `src/components/arithmetic/add.ts:205-208`
- **Rule violated**: Completeness — spec requires the `executeFn` to read component `bitWidth` via `layout.getProperty`. The spec said: "The registered `executeFn` must read the component's `bitWidth` property and call `makeExecuteAdd(bitWidth)` with the correct value."
- **Evidence** (current `add.ts`):
  ```typescript
  export function executeAdd(index: number, state: Uint32Array, layout: ComponentLayout): void {
    const bitWidth = (layout.getProperty?.(index, "bitWidth") as number | undefined) ?? 1;
    makeExecuteAdd(bitWidth)(index, state, layout);
  }
  ```
- **Severity**: critical
- **Analysis**: The current implementation at `add.ts:205-208` is correct — `executeAdd` does read `bitWidth` from `layout.getProperty`. However, the F1 progress entry states "Files modified: `src/components/arithmetic/__tests__/arithmetic.test.ts`" and "Files created: none" — claiming only the test file was changed. The progress note describes the pre-existing `executeAdd` as already correct ("verified existing dynamic dispatch"). This requires careful investigation: if `add.ts:205-208` already existed with correct `getProperty` logic **before** Wave FIX.1, then F1 was never actually broken as described (hardcoding `makeExecuteAdd(1)` in the registered `executeFn`). But if the progress entry is truthful and only the tests changed, then the defect described in `fix-spec.md` F1 ("always calls `makeExecuteAdd(1)` regardless of the component's actual `bitWidth`") was NOT present in the source — meaning the spec's diagnosis was wrong and no fix was needed. Either way, one of these is true:
  - (a) The defect existed and was fixed but the progress note omits the source-file change — an undocumented modification.
  - (b) The defect never existed, and F1 was a false alarm — in which case the acceptance criterion "executeFn reads bitWidth from layout" was already satisfied before this wave.
  The progress note also states: "Note: The `AddDefinition.executeFn` is registered as `executeAdd` which already delegates to `makeExecuteAdd(bitWidth)` via `layout.getProperty`." This implies the defect described in the spec was inaccurate. Regardless of which scenario is correct, the progress entry cannot be accurate if it says only the test file was modified AND the source was already correct — the reviewer cannot verify which state the file was in before this wave without `git diff`. This is flagged as critical because the progress entry's claim of "files modified: test only" is inconsistent with the spec's diagnosis of a source defect. If only tests were added to verify already-correct code, that is acceptable — but the spec did not authorize test-only work for F1 when it said there was a bug.

---

### V3 — MAJOR: `jk-synthesis.test.ts` never tests `shouldMinimize=false` path

- **File**: `src/analysis/__tests__/jk-synthesis.test.ts`
- **Rule violated**: Spec adherence — F3 spec requires: "Apply minimization to the JK synthesis expressions when `shouldMinimize === true`. Follow the same pattern as the corrected `synthesizeD`." The progress note for F3 states: "Updated all 4 call sites in jk-synthesis.test.ts to pass `true`. Added synthesizeJK minimize:false test to circuit-gen.test.ts."
- **Evidence**: All four `deriveJKEquations` calls in `jk-synthesis.test.ts` pass `true`:
  ```
  src/analysis/__tests__/jk-synthesis.test.ts:64:  const result = deriveJKEquations(table, true);
  src/analysis/__tests__/jk-synthesis.test.ts:103: const result = deriveJKEquations(table, true);
  src/analysis/__tests__/jk-synthesis.test.ts:166: const result = deriveJKEquations(table, true);
  src/analysis/__tests__/jk-synthesis.test.ts:216: const result = deriveJKEquations(table, true);
  ```
  None call `deriveJKEquations(table, false)`. The spec says to test the `shouldMinimize` parameter in the JK unit tests. The `minimize:false` test exists only at the higher `circuit-gen.test.ts` level (via `fsmToCircuit` options), not in `jk-synthesis.test.ts` itself.
- **Severity**: major
- **Analysis**: The `deriveJKEquations` function now accepts `shouldMinimize: boolean` and threads it through three callsites (`jExpr`, `kExpr`, `deriveOutputExprs`). None of the four unit tests in `jk-synthesis.test.ts` exercise the `shouldMinimize=false` code path directly. The spec's F3 fix specifically required verifying the parameter is used; testing only `shouldMinimize=true` at unit level does not verify the `false` branch.

---

### V4 — MAJOR: `circuit-gen.test.ts` F2/F3 test assertions are weak structural checks, not behavioral verification of minimize vs. raw SOP

- **File**: `src/fsm/__tests__/circuit-gen.test.ts:358-428` (tests `synthesizeD — minimize:false` and `synthesizeJK — minimize:false`)
- **Rule violated**: Testing — "Test the specific: exact values, exact types, exact error messages where applicable." Assertions must test desired behaviour.
- **Evidence**:
  ```typescript
  // synthesizeD minimize:false test
  expect(minCircuit.elements.length).toBeGreaterThan(0);
  expect(rawCircuit.elements.length).toBeGreaterThan(0);
  expect(Array.isArray(rawCircuit.wires)).toBe(true);
  expect(countByType(rawCircuit, 'Out')).toBeGreaterThanOrEqual(1);
  expect(rawCircuit.elements.length).toBeGreaterThanOrEqual(minCircuit.elements.length);
  ```
  ```typescript
  // synthesizeJK minimize:false test
  expect(minCircuit.elements.length).toBeGreaterThan(0);
  expect(rawCircuit.elements.length).toBeGreaterThan(0);
  expect(Array.isArray(rawCircuit.wires)).toBe(true);
  expect(rawOutLabels.some((l) => l.includes('_J'))).toBe(true);
  expect(rawOutLabels.some((l) => l.includes('_K'))).toBe(true);
  expect(rawCircuit.elements.length).toBeGreaterThanOrEqual(minCircuit.elements.length);
  ```
- **Severity**: major
- **Analysis**: These tests are designed to verify F2 (`synthesizeD` uses raw SOP when `shouldMinimize=false`) and F3 (`synthesizeJK` threads `shouldMinimize` through). The actual bug was that BOTH branches called `minimize()`. A test that only checks `circuit.elements.length > 0` and `Array.isArray(circuit.wires)` cannot distinguish a fixed implementation from the broken one — the broken version (both branches calling `minimize()`) would also produce `elements.length > 0` and a valid wire array. The `rawCircuit.elements.length >= minCircuit.elements.length` assertion is the closest to a behavioral check, but it is based on an unproven assumption ("unminimized SOP is never simpler than minimized") that may fail for the specific 2-state FSM used. The correct verification for F2/F3 would be: call `generateSOP` directly on the truth table and verify the `rawCircuit` contains an expression tree that matches the unminimized SOP structure — or at minimum, verify that the expression string for the raw path contains explicit minterms/products that the minimized path simplifies away.

---

### V5 — MINOR: `resolves.toBeDefined()` assertion is trivially true

- **File**: `src/hgs/__tests__/hgs-parity.test.ts:522`
- **Rule violated**: Testing — no trivially true assertions.
- **Evidence**:
  ```typescript
  it("isPresent returns false without propagating evaluation error", async () => {
    const ctx = createRootContext();
    registerBuiltins(ctx);
    const ast = parse("result := isPresent(nosuchvar);");
    await expect(evaluate(ast, ctx)).resolves.toBeDefined();
    expect(ctx.getVar("result")).toBe(false);
  });
  ```
- **Severity**: minor
- **Analysis**: `evaluate()` returns `Promise<string>` (the output string). `resolves.toBeDefined()` asserts the promise resolves to a non-undefined value. Since `evaluate` always returns a string (even `""` is not undefined), this assertion is trivially true and can never fail. The meaningful assertion is on line 523 (`toBe(false)`), which is correct and sufficient. The `resolves.toBeDefined()` line adds noise without value and is a textbook trivially-true assertion.

---

## Gaps

### G1: F1 spec acceptance criterion "Check all other arithmetic components (Sub, Mul, Div) for the same pattern" — source files not identified in progress entry

- **Spec requirement**: F1 states: "Check all other arithmetic components (Sub, Mul, Div) for the same pattern." The spec implies the fix should be verified at the source level for all four arithmetic components.
- **What was found**: The progress entry for F1 says "Files modified: `src/components/arithmetic/__tests__/arithmetic.test.ts`" only. No source files (`sub.ts`, `mul.ts`, `div.ts`) are listed as modified. The test file does include dynamic-dispatch tests for all four components (Add, Sub, Mul, Div via their respective `executeAdd`, `executeSub`, `executeMul`, `executeDiv` wrapper functions). Whether the source defect was actually present and fixed in all four files, or was never present, cannot be determined from the progress entry alone.
- **File**: `spec/progress.md` (F1 entry); source files `src/components/arithmetic/{sub,mul,div}.ts` not listed.

---

## Weak Tests

### WT1: `circuit-gen.test.ts::fsmToCircuit::simpleCounter` — `elements.length > 0` is structurally trivial

- **Test path**: `src/fsm/__tests__/circuit-gen.test.ts::fsmToCircuit::simpleCounter`
- **What's wrong**: `expect(circuit.elements.length).toBeGreaterThan(0)` does not verify that the correct elements were synthesized from the FSM. Any non-empty circuit passes.
- **Evidence**: `expect(circuit.elements.length).toBeGreaterThan(0);`

### WT2: `circuit-gen.test.ts::fsmToCircuit::simpleCounter` — `outCount >= 1` and `inCount >= 1` are trivially weak

- **Test path**: `src/fsm/__tests__/circuit-gen.test.ts::fsmToCircuit::simpleCounter`
- **What's wrong**: `expect(outCount).toBeGreaterThanOrEqual(1)` and `expect(inCount).toBeGreaterThanOrEqual(1)` accept any circuit with at least one In and one Out, regardless of correctness.
- **Evidence**: `expect(outCount).toBeGreaterThanOrEqual(1);` / `expect(inCount).toBeGreaterThanOrEqual(1);`

### WT3: `circuit-gen.test.ts::fsmToCircuit::jkFlipflops` — `elements.length > 0` is trivially weak

- **Test path**: `src/fsm/__tests__/circuit-gen.test.ts::fsmToCircuit::jkFlipflops`
- **What's wrong**: `expect(circuit.elements.length).toBeGreaterThan(0)` does not verify JK-specific synthesis correctness.
- **Evidence**: `expect(circuit.elements.length).toBeGreaterThan(0);`

### WT4: `circuit-gen.test.ts::fsmToCircuit::functionalVerification` — verifies transition table, not synthesized circuit

- **Test path**: `src/fsm/__tests__/circuit-gen.test.ts::fsmToCircuit::functionalVerification`
- **What's wrong**: The test verifies the original FSM's transition table entries (`table.transitions`), not the synthesized circuit's behaviour. The final `expect(circuit.elements.length).toBeGreaterThan(0)` is trivially weak. The test name says "functional verification" but it verifies the FSM model, not the circuit.
- **Evidence**: `expect(circuit.elements.length).toBeGreaterThan(0);`

### WT5: `circuit-gen.test.ts::fsmToCircuit::minimizedExpressions` — structural checks only

- **Test path**: `src/fsm/__tests__/circuit-gen.test.ts::fsmToCircuit::minimizedExpressions`
- **What's wrong**: Checks `elements.length > 0`, `inCount >= 1`, `outCount >= 1`, and `Array.isArray(wires)`. None of these verify that minimization actually occurred or that the expressions are correct.
- **Evidence**: `expect(minimizedCircuit.elements.length).toBeGreaterThan(0);`

### WT6: `circuit-gen.test.ts::fsmToCircuit::synthesizeD` — `elements.length >= minCircuit.elements.length` is an assumption, not a proof

- **Test path**: `src/fsm/__tests__/circuit-gen.test.ts::fsmToCircuit::synthesizeD — minimize:false uses raw SOP not minimize()`
- **What's wrong**: The assertion `rawCircuit.elements.length >= minCircuit.elements.length` assumes raw SOP always produces more elements. For this specific 2-state/1-input FSM, `generateSOP` for the single minterm `(!Q & A)` produces exactly one minterm. `minimize()` would also produce `(!Q & A)` or simplify to `A` (since `Q=1` is the don't-care for the D flip-flop output). The raw SOP could have fewer or equal elements. The assumption may be true or false depending on the expression; it is not a reliable discriminator.
- **Evidence**: `expect(rawCircuit.elements.length).toBeGreaterThanOrEqual(minCircuit.elements.length);`

### WT7: `circuit-gen.test.ts::fsmToCircuit::synthesizeJK` — same assumption-based assertion

- **Test path**: `src/fsm/__tests__/circuit-gen.test.ts::fsmToCircuit::synthesizeJK — minimize:false uses raw SOP not minimize()`
- **What's wrong**: Same as WT6. `rawCircuit.elements.length >= minCircuit.elements.length` is an unverified assumption. For the toggle FSM (J=1, K=1 after minimization), raw SOP might actually produce more elements (one minterm per '1' row) or not, depending on how `synthesizeCircuit` handles constant-true expressions.
- **Evidence**: `expect(rawCircuit.elements.length).toBeGreaterThanOrEqual(minCircuit.elements.length);`

---

## Legacy References

None found.

---

## Notes for Orchestrator

1. **V1 (critical)**: The `builtinIsPresent` stub in `builtins.ts` was not cleaned up. The function body `async (_args) => true` is dead code — the evaluator intercepts `isPresent` calls before this is ever called — but it constitutes misleading code. The body should be updated or removed to match the actual semantics (or the stub should clearly do nothing useful since it is never invoked). The spec M2 also required removing the "For now" comment block from `builtins.ts:250-254` — searching found no such comment exists now, so M2 may have been pre-emptively absent, but the stub body itself still contradicts the implementation.

2. **V2 (critical)**: The F1 progress note's claim that only the test file was modified is inconsistent with the spec's diagnosis of a source defect. A `git diff HEAD~1 src/components/arithmetic/add.ts` would resolve this. If `add.ts` was correct before Wave FIX.1, the spec's diagnosis was a false alarm and the task was test-only — which is acceptable, but the progress entry should have said so explicitly. If `add.ts` was modified, the progress entry omits a changed file, which is a documentation defect.

3. **WT6/WT7**: The `rawCircuit.elements.length >= minCircuit.elements.length` assertions may be fragile. For the specific 2-state/1-input FSM used, Quine-McCluskey can simplify `(!Q & A)` to `A` (one gate vs two), making the raw circuit actually larger — which would satisfy the assertion. But for FSMs where minimization yields no simplification, raw SOP and minimized SOP produce identical element counts, making `>=` pass vacuously. The assertions should be replaced with direct verification that `generateSOP` is called (e.g., by checking the output expression string contains explicit minterm products).
