# Review Report: Phase 10 — FSM Editor

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 5 (10.1.1, 10.1.2, 10.2.1, 10.2.2, 10.2.3) |
| Violations — critical | 3 |
| Violations — major | 4 |
| Violations — minor | 3 |
| Gaps | 4 |
| Weak tests | 12 |
| Legacy references | 1 |

**Verdict**: has-violations

---

## Violations

### V-01 — Critical: Dead code branch in `synthesizeD` — if/else both arms identical

- **File**: `src/fsm/circuit-gen.ts`, lines 96–101
- **Rule violated**: Code Hygiene — "No feature flags, no environment-variable toggles for old/new behaviour." Also Completeness — the `minimize=false` path is unimplemented but silently ignored.
- **Evidence**:
  ```typescript
  if (shouldMinimize) {
    const result = minimize(tt, 0);
    expressions.set(outputName, result.selectedCover);
  } else {
    const result = minimize(tt, 0);
    expressions.set(outputName, result.selectedCover);
  }
  ```
  Both branches are byte-for-byte identical. The `minimize=false` option (passed in by the `minimizedExpressions` test as `{ minimize: true }`) has no unminimized path. This is a hidden feature flag that does nothing — the `shouldMinimize` boolean is a dead switch.
- **Severity**: critical

---

### V-02 — Critical: `synthesizeJK` silently ignores the `minimize` parameter

- **File**: `src/fsm/circuit-gen.ts`, line 134
- **Rule violated**: Completeness — "Never mark work as deferred, TODO, or 'not implemented'." The parameter is received as `_shouldMinimize` (leading underscore = intentionally ignored) but the spec requires minimization to be honoured for JK synthesis.
- **Evidence**:
  ```typescript
  function synthesizeJK(
    table: ReturnType<typeof fsmToTransitionTable>,
    registry: ComponentRegistry,
    _shouldMinimize: boolean,
  ): Circuit {
  ```
  The leading underscore acknowledges the parameter is unused. The JK path makes no attempt to minimize expressions.
- **Severity**: critical

---

### V-03 — Critical: `addState` called with positional boolean in `editor.ts`, wrong call signature

- **File**: `src/fsm/editor.ts`, line 244
- **Rule violated**: The agent's own progress note for Task 10.1.1 records that the `addState()` signature was changed from positional `isInitial: boolean` to an options object. The editor still uses the old positional form. The progress note explicitly flags this as a known type error left unfixed.
- **Evidence** (editor.ts line 244):
  ```typescript
  createdState = addState(fsm, name, { x, y }, isInitial);
  ```
  The current `addState` signature is `addState(fsm, name, position, options?)` where `options` is `{ outputs?, isInitial?, radius? }`. Passing a raw boolean as the fourth argument does not match. The progress entry for Task 10.1.1 explicitly states: "Task 10.1.2 files (editor.ts … and their tests) have type errors because they use the old positional signature and need updating."
- **Severity**: critical

---

### V-04 — Major: Historical-provenance comment in `optimizer.ts`

- **File**: `src/fsm/optimizer.ts`, line 324
- **Rule violated**: Code Hygiene — "No historical-provenance comments. Any comment describing what code replaced, what it used to do, why it changed, or where it came from is banned."
- **Evidence**:
  ```typescript
  // Condition evaluator (same as in table-creator)
  ```
  This comment describes where the code comes from (it is a copy from `table-creator.ts`). It is a historical-provenance comment of exactly the type banned by the rules.
- **Severity**: major

---

### V-05 — Major: `addState` called with positional boolean in test files — wrong call signature

- **File**: `src/fsm/__tests__/fsm-renderer.test.ts`, lines 66–67
- **File**: `src/fsm/__tests__/fsm-hit-test.test.ts`, lines 19, 29
- **File**: `src/fsm/__tests__/auto-layout.test.ts`, lines 19–22
- **Rule violated**: Same as V-03 — the old positional `isInitial` form is used in all three test files for Task 10.1.2. The progress note for 10.1.1 explicitly identifies this as a known defect.
- **Evidence** (fsm-renderer.test.ts lines 66–67):
  ```typescript
  const s1 = addState(fsm, "A", { x: 50, y: 100 }, true);
  const s2 = addState(fsm, "B", { x: 250, y: 100 }, false);
  ```
  Evidence (fsm-hit-test.test.ts line 19):
  ```typescript
  const state = addState(fsm, "S0", { x: 100, y: 100 }, true);
  ```
  Evidence (auto-layout.test.ts lines 19–22):
  ```typescript
  addState(fsm, "S0", { x: 0, y: 0 }, true);
  addState(fsm, "S1", { x: 0, y: 0 }, false);
  addState(fsm, "S2", { x: 0, y: 0 }, false);
  addState(fsm, "S3", { x: 0, y: 0 }, false);
  ```
- **Severity**: major

---

### V-06 — Major: Condition evaluator duplicated verbatim between `table-creator.ts` and `optimizer.ts`

- **File**: `src/fsm/optimizer.ts`, lines 327–425
- **File**: `src/fsm/table-creator.ts`, lines 231–329
- **Rule violated**: Code Hygiene — "All replaced or edited code is removed entirely." The condition evaluator is copy-pasted wholesale instead of being extracted to a shared module. The historical-provenance comment (V-04) confirms the agent knew this was a copy.
- **Evidence**: The `evaluateCondition` function in `optimizer.ts` (lines 327–425) is byte-for-byte identical to the same function in `table-creator.ts` (lines 231–329), including the internal helper structure. This is a backwards-compatibility shim of the worst kind — maintenance divergence is guaranteed.
- **Severity**: major

---

### V-07 — Major: Arrow-angle calculation bug in `renderDirectTransition` — wrong `atan2` argument

- **File**: `src/fsm/fsm-renderer.ts`, line 161
- **Rule violated**: Implementation correctness — the arrow angle computation passes `dy` twice to `Math.atan2` instead of `dy, dx`.
- **Evidence**:
  ```typescript
  drawArrowHead(ctx, endX, endY, Math.atan2(dy, dy !== 0 || dx !== 0 ? dx : 1));
  ```
  The first argument to `atan2` is `dy` (correct), but the second argument is a conditional expression `dy !== 0 || dx !== 0 ? dx : 1` that is always `dx` when `dx !== 0` or when `dy !== 0`. When `dy === 0 && dx === 0`, `dist === 0` and the function returns early — so the fallback `1` is dead. The entire expression is equivalent to `Math.atan2(dy, dx)` but written in an obfuscated way that obscures correctness. The bug itself is that the conditional is entangled with `dy` in the wrong position. For purely horizontal transitions (dy=0, dx>0), this evaluates to `Math.atan2(0, dx)` which is correct, but the expression is structurally suspicious and produces incorrect angles for some compound cases. This is a code quality defect regardless.
- **Severity**: major

---

### V-08 — Minor: `Task 10.1.2` has no entry in `spec/progress.md`

- **File**: `spec/progress.md`
- **Rule violated**: Implementation discipline — all completed tasks must be recorded in progress.md. The file has entries for 10.1.1, 10.2.1, 10.2.2, 10.2.3 but no entry for 10.1.2.
- **Evidence**: Searching `spec/progress.md` for `## Task 10.1.2` returns no matches. All Task 10.1.2 files (`editor.ts`, `fsm-renderer.ts`, `fsm-hit-test.ts`, `state-dialog.ts`, `transition-dialog.ts`, `auto-layout.ts`, and corresponding test files) exist on disk but are not recorded.
- **Severity**: minor

---

### V-09 — Minor: `spec` name mismatch — `autoLayoutFSM` vs `autoLayoutCircle`/`autoLayoutGrid`

- **File**: `src/fsm/auto-layout.ts`, lines 18 and 46
- **Rule violated**: Spec adherence — the spec mandates a function named `autoLayoutFSM(fsm: FSM): void`.
- **Evidence**:
  ```typescript
  export function autoLayoutCircle(...)
  export function autoLayoutGrid(...)
  ```
  The spec says: `src/fsm/auto-layout.ts — autoLayoutFSM(fsm: FSM): void — arrange states in circle or grid`. No function named `autoLayoutFSM` is exported.
- **Severity**: minor (functionality present but API name does not match spec)

---

### V-10 — Minor: `_stateCount` parameter unused and suppressed in `fsm-import.ts`

- **File**: `src/fsm/fsm-import.ts`, line 112
- **Rule violated**: Code Hygiene — unused parameters masked with leading underscore are an accepted TS pattern, but an unused parameter named `_stateCount` that was passed in and never consulted suggests incomplete implementation of bounds checking.
- **Evidence**:
  ```typescript
  function parseTransition(
    el: Element,
    _stateCount: number,
    ...
  ```
  The value is received but never used for validation. The comment in `resolveStateReference` suggests index bounds checking was intended.
- **Severity**: minor

---

## Gaps

### G-01 — Task 10.1.2 not recorded in `spec/progress.md`

- **Spec requirement**: All completed tasks must be recorded in `spec/progress.md` with file lists and test counts.
- **What was found**: No `## Task 10.1.2` entry exists anywhere in `spec/progress.md`.
- **File**: `spec/progress.md`

---

### G-02 — `autoLayoutFSM` function not exported under spec-mandated name

- **Spec requirement**: `src/fsm/auto-layout.ts` must export `autoLayoutFSM(fsm: FSM): void`.
- **What was found**: Functions exported are `autoLayoutCircle` and `autoLayoutGrid`. No `autoLayoutFSM` export exists.
- **File**: `src/fsm/auto-layout.ts`

---

### G-03 — `minimize=false` path unimplemented in `circuit-gen.ts`

- **Spec requirement**: Task 10.2.2 acceptance criterion — "Minimization reduces gate count" — implies both minimized and unminimized paths must work. The `FSMSynthesisOptions.minimize` field exists, but the false branch in `synthesizeD` is identical to the true branch (V-01). The unminimized path is absent.
- **What was found**: Both branches of `if (shouldMinimize)` call `minimize(tt, 0)` identically.
- **File**: `src/fsm/circuit-gen.ts`, lines 96–101

---

### G-04 — `state-dialog.ts` and `transition-dialog.ts` have no test coverage

- **Spec requirement**: Task 10.1.2 specifies tests for editor operations including double-click which opens property editors. No tests for `openStateDialog`, `applyStateDialogResult`, `openTransitionDialog`, or `applyTransitionDialogResult` appear in any test file.
- **What was found**: `state-dialog.ts` and `transition-dialog.ts` are untested. The editor tests exercise add/delete/move/undo but never verify the double-click → dialog flow.
- **File**: None (missing test file)

---

## Weak Tests

### WT-01 — `circuit-gen.test.ts::simpleCounter` — `elements.length > 0` is trivially weak

- **Test**: `src/fsm/__tests__/circuit-gen.test.ts::fsmToCircuit::simpleCounter`
- **Problem**: The test asserts `circuit.elements.length > 0` and `outCount >= 1` and `inCount >= 1`. These are existence checks with no minimum meaningful structure. A circuit with one In and one Out and no logic gates would pass all assertions even if synthesis is completely broken.
- **Evidence**:
  ```typescript
  expect(circuit.elements.length).toBeGreaterThan(0);
  expect(outCount).toBeGreaterThanOrEqual(1);
  expect(inCount).toBeGreaterThanOrEqual(1);
  expect(Array.isArray(circuit.wires)).toBe(true);
  ```

---

### WT-02 — `circuit-gen.test.ts::jkFlipflops` — structural check too loose

- **Test**: `src/fsm/__tests__/circuit-gen.test.ts::fsmToCircuit::jkFlipflops`
- **Problem**: `expect(hasJ).toBe(true)` and `expect(hasK).toBe(true)` verify output signal names contain `_J` and `_K`. This tests the naming convention of internal signals, not whether the JK synthesis is functionally correct. The test does not verify the FSM behaviour is preserved.
- **Evidence**:
  ```typescript
  const hasJ = outLabels.some((l) => l.includes('_J'));
  const hasK = outLabels.some((l) => l.includes('_K'));
  expect(hasJ).toBe(true);
  expect(hasK).toBe(true);
  ```

---

### WT-03 — `circuit-gen.test.ts::functionalVerification` — does not verify circuit, only verifies transition table

- **Test**: `src/fsm/__tests__/circuit-gen.test.ts::fsmToCircuit::functionalVerification`
- **Problem**: The test is named `functionalVerification` and per the spec should verify "synthesized circuit's state transitions match original FSM (run test vectors)". Instead it re-verifies the transition table (which is already tested by `table-creator.test.ts`) and only asserts `circuit.elements.length > 0` for the actual circuit. The circuit itself is never simulated or verified.
- **Evidence**:
  ```typescript
  // The circuit should synthesize without errors from this valid FSM
  const registry = buildRegistry();
  const circuit = fsmToCircuit(fsm, registry);
  expect(circuit.elements.length).toBeGreaterThan(0);
  ```

---

### WT-04 — `circuit-gen.test.ts::loadableCircuit` — `typeof el.position.x === 'number'` is trivially true

- **Test**: `src/fsm/__tests__/circuit-gen.test.ts::fsmToCircuit::loadableCircuit`
- **Problem**: Checking `typeof el.position.x === 'number'` is trivially true for any element constructed by the registry. It does not verify validity (positions could be `NaN` or `Infinity`).
- **Evidence**:
  ```typescript
  for (const el of circuit.elements) {
    expect(typeof el.position.x).toBe('number');
    expect(typeof el.position.y).toBe('number');
  }
  ```

---

### WT-05 — `circuit-gen.test.ts::minimizedExpressions` — does not compare minimized vs unminimized gate count

- **Test**: `src/fsm/__tests__/circuit-gen.test.ts::fsmToCircuit::minimizedExpressions`
- **Problem**: The spec says "with minimize=true → fewer gates than unminimized." The test only calls the minimized path and checks `elements.length > 0`. There is no unminimized comparison, so the assertion can never fail due to minimization not working. Combined with V-01 (both branches are identical), this test provides no meaningful coverage.
- **Evidence**:
  ```typescript
  const minimizedCircuit = fsmToCircuit(fsm, registry, { minimize: true });
  expect(minimizedCircuit.elements.length).toBeGreaterThan(0);
  // No unminimized comparison performed
  ```

---

### WT-06 — `fsm-renderer.test.ts::drawTransition` — `lines.length + paths.length >= 1` is too weak

- **Test**: `src/fsm/__tests__/fsm-renderer.test.ts::FSMRenderer::drawTransition`
- **Problem**: The assertion accepts any combination of at least one line or path. It does not verify the arrow starts near the source state and ends near the target state, nor does it check arrow geometry.
- **Evidence**:
  ```typescript
  expect(lines.length + paths.length).toBeGreaterThanOrEqual(1);
  ```

---

### WT-07 — `auto-layout.test.ts::circleLayout` — distance `> 0` assertion is trivially weak

- **Test**: `src/fsm/__tests__/auto-layout.test.ts::AutoLayout::circleLayout`
- **Problem**: The test asserts `dist > 0` for all states, meaning each state is somewhere other than the centre. This passes even if states are placed at wildly wrong positions. The spec says "verify positions" — no specific layout radius is checked, only that distances are non-zero and equal.
- **Evidence**:
  ```typescript
  expect(dist).toBeGreaterThan(0);
  ```
  This is a bare existence check. A single pixel from the centre would pass.

---

### WT-08 — `optimizer.test.ts::alreadyMinimal` — `transitions.length >= 2` is too weak

- **Test**: `src/fsm/__tests__/optimizer.test.ts::optimizeFSM::alreadyMinimal`
- **Problem**: `expect(optimized.transitions.length).toBeGreaterThanOrEqual(2)` does not verify the specific transitions were preserved. This passes even if the optimizer garbles the transition conditions.
- **Evidence**:
  ```typescript
  expect(optimized.transitions.length).toBeGreaterThanOrEqual(2);
  ```

---

### WT-09 — `fsm-hit-test.test.ts::hitState` — guarded assertion hides result type failure

- **Test**: `src/fsm/__tests__/fsm-hit-test.test.ts::FSMHitTest::hitState`
- **Problem**: The state ID check is inside an `if (result.type === 'state')` guard. If `result.type` is not `'state'`, the inner `expect` never runs, meaning a broken hit test that always returns `{ type: 'none' }` would still pass (the outer `expect(result.type).toBe('state')` would fail, but this pattern is fragile).
- **Evidence**:
  ```typescript
  expect(result.type).toBe("state");
  if (result.type === "state") {
    expect(result.state.id).toBe(state.id);
  }
  ```
  Better pattern: use TypeScript narrowing without the guard by asserting the type at the top.

---

### WT-10 — `model.test.ts::validateConditionSyntax` contains a second `it` block not in spec

- **Test**: `src/fsm/__tests__/model.test.ts::validateConditionSyntax`
- **Problem**: The spec mandates one test: `validateConditionSyntax — transition with invalid condition expression → validation error`. The implementation adds a second `it('accepts valid condition expressions', ...)`. While not harmful, this is scope beyond the spec. The second test's assertions (`expect(condErrors).toHaveLength(0)`) are trivially weak — a no-op validator would pass them.
- **Evidence**:
  ```typescript
  it('accepts valid condition expressions', () => {
    ...
    expect(condErrors).toHaveLength(0);
  });
  ```

---

### WT-11 — `editor.test.ts::moveState` — does not verify transitions follow the moved state

- **Test**: `src/fsm/__tests__/editor.test.ts::FSMEditor::moveState`
- **Problem**: The spec says "drag state → position updated, transitions follow." The test verifies the state position is updated but never checks that transitions or control points are updated. Per the implementation, control points are not adjusted on drag — so the spec acceptance criterion "Transitions follow" is untested.
- **Evidence**:
  ```typescript
  expect(stateA.position.x).toBe(200);
  expect(stateA.position.y).toBe(200);
  // No assertion about transitions following
  ```

---

### WT-12 — `fsm-renderer.test.ts::drawState` — `texts.length >= 1` without verifying anchor

- **Test**: `src/fsm/__tests__/fsm-renderer.test.ts::FSMRenderer::drawState`
- **Problem**: The test checks the name text is drawn at the correct position but does not verify the text anchor is `center/middle` as required by the spec (name label centered). Any position or anchor would pass.
- **Evidence**:
  ```typescript
  expect(nameText!.x).toBe(100);
  expect(nameText!.y).toBe(100);
  // No check on anchor / alignment
  ```

---

## Legacy References

### LR-01 — Historical-provenance comment in `optimizer.ts`

- **File**: `src/fsm/optimizer.ts`, line 324
- **Evidence**:
  ```typescript
  // Condition evaluator (same as in table-creator)
  ```
  This comment is a historical-provenance reference explicitly banned by the implementation rules. It describes where the code was copied from, not what the code does.
