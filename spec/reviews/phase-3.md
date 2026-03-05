# Review Report: Phase 3 — Simulation Engine

## Summary

- **Tasks reviewed**: 14 (3.1.1, 3.1.2, 3.1.3, 3.2.2, 3.2.3, 3.3.1, 3.3.2, 3.3.3, 3.4.1, 3.4.3, 3.4.4, 3.4.5, 3.5.1, 3.5.2)
- **Violations**: 6 (2 critical, 4 major, 0 minor)
- **Gaps**: 0
- **Weak tests**: 2
- **Legacy references**: 0
- **Verdict**: has-violations

---

## Violations

### Violation 1

- **File**: `src/engine/run-to-break.ts`, line 85
- **Rule violated**: Rules — Code Hygiene; also breaks spec acceptance criterion for task 3.4.3 ("Break components are detected by type string `"Break"`").
- **Severity**: critical
- **Evidence**:
  ```typescript
  if (element.type === "Break") {
  ```
  The `CircuitElement` interface (defined in `src/core/element.ts`) exposes only `typeId: string`, not `type`. The property `element.type` is always `undefined` at runtime, so `findBreakComponents` always returns an empty array. The `run()` method consequently never halts early on a Break component — it always runs to `maxSteps`. Break detection is permanently non-functional in the production path.

---

### Violation 2

- **File**: `src/engine/digital-engine.ts`, lines 271–275
- **Rule violated**: Rules — Completeness ("Never mark work as deferred, TODO, or 'not implemented'"); Rules — Code Hygiene (banned historical-provenance/workaround comments — "for now" is explicitly listed as a red flag).
- **Severity**: critical
- **Evidence**:
  ```typescript
  // Break components would set a flag via their executeFn; for now
  // there is no Break component mechanism — just run one full pass.
  break;
  ```
  The `runToBreak()` method in `DigitalEngine` unconditionally breaks after a single pass, ignoring Break component detection entirely. The comment explicitly acknowledges the incompleteness and uses the banned phrase "for now." This is deferred/incomplete production code with a justification comment — both are prohibited by the rules.

---

### Violation 3

- **File**: `src/engine/digital-engine.ts`, line 443
- **Rule violated**: Spec acceptance criterion for task 3.1.1: "Zero object allocation in the level-by-level inner loop (only Uint32Array index access and function calls)."
- **Severity**: major
- **Evidence**:
  ```typescript
  const prevOutputs = new Uint32Array(outputNets.length);
  ```
  This allocation appears inside `_evaluateFeedbackGroup`, which is called per-SCC during each evaluation pass. Each invocation allocates a new `Uint32Array` on the heap. This directly violates the zero-allocation acceptance criterion for the inner evaluation loop.

---

### Violation 4

- **File**: `src/engine/digital-engine.ts`, lines 524–525
- **Rule violated**: Spec acceptance criterion for task 3.1.1: "Zero object allocation in the level-by-level inner loop."
- **Severity**: major
- **Evidence**:
  ```typescript
  const outCount = layout.outputCount(_index);
  const prevOutputs = new Uint32Array(outCount);
  ```
  This allocation appears inside `_stepTimed()` in the per-component loop. A `new Uint32Array` is created for every component on every timed step. This is a per-iteration heap allocation inside the simulation inner loop, directly violating the zero-allocation acceptance criterion.

---

### Violation 5

- **File**: `src/engine/noise-mode.ts`, lines 82–163
- **Rule violated**: Rules — Code Hygiene: "No historical-provenance comments. Any comment describing what code replaced, what it used to do, why it changed, or where it came from is banned."
- **Severity**: major
- **Evidence** (representative excerpt):
  ```typescript
  // Actually the simplest correct approach:
  // ...
  // But we cannot easily distinguish between "this component set it this step"
  // and "this component set it last step but another component is now driving it."
  // ...
  // After more thought: the correct approach is ...
  // Previously we tried ...
  ```
  The `evaluateSynchronized` function contains approximately 80 lines of multi-paragraph commentary describing multiple design approaches that were considered and rejected before arriving at the final implementation. These are explicit historical-provenance and design-iteration comments that describe what was tried before the current approach — banned in their entirety by the rules. A comment that explains the difficulty of the problem does not justify this. The presence of this comment block is evidence that the agent knowingly chose a complex path and documented the discarded alternatives instead of simply deleting them.

---

### Violation 6

- **File**: `src/engine/noise-mode.ts`, line 209
- **Rule violated**: Spec acceptance criterion for task 3.1.3 (zero-allocation inner evaluation loop); Rules — Code Hygiene (no backwards-compatibility shims / safety wrappers).
- **Severity**: major
- **Evidence**:
  ```typescript
  const snapshot = new Uint32Array(snapshotBuffer);
  ```
  This allocation appears inside `evaluateSynchronized`, within the per-component loop. A new `Uint32Array` view/copy is created for every component on every noise-mode evaluation pass. This is a heap allocation inside the evaluation inner loop.

---

## Gaps

None found.

All files specified in the phase spec for the 14 tasks in scope were created. All files specified for modification were modified. All required test names are present in their respective test files.

---

## Weak Tests

### Weak Test 1

- **Test path**: `src/engine/__tests__/controls.test.ts::Controls::speedControlsStepsPerFrame`
- **What is wrong**: The test does not test the actual spec requirement — that the `SimulationController` drives multiple simulation steps per animation frame according to the `stepsPerFrame` setting. Instead, it calls `step()` manually 10 times in a loop and asserts that `stepCount === 10`. This validates that `step()` increments a counter, which is trivially true and unrelated to the rAF-based speed control behavior specified for task 3.4.1. The test comment inside the file also admits that the real behavior (rAF scheduling) cannot be tested this way.
- **Evidence**:
  ```typescript
  // Manually drive 10 steps to simulate stepsPerFrame behavior
  for (let i = 0; i < 10; i++) {
    controller.step();
  }
  expect(stepCount).toBe(10);
  ```

---

### Weak Test 2

- **Test path**: `src/engine/__tests__/run-to-break.test.ts` (all tests using `buildCircuit` helper)
- **What is wrong**: The test helper stubs circuit elements using `{ type: "Break" }` to populate the `componentElements` map. The implementation in `run-to-break.ts` also reads `element.type` (the wrong property — the real interface uses `typeId`). As a result, the tests accidentally pass because both the test stub and the implementation share the same incorrect property name. The tests therefore validate incorrect behavior: they confirm that `element.type === "Break"` works when `element.type` is set on the stub, but the real `CircuitElement` objects never have a `type` property. The tests give false confidence in a broken implementation.
- **Evidence** (test helper):
  ```typescript
  componentElements.set(breakIdx, { type: "Break" } as unknown as CircuitElement);
  ```
  Evidence (implementation, violation 1):
  ```typescript
  if (element.type === "Break") {
  ```
  The tests exercise the wrong code path and would fail with real `CircuitElement` instances.

---

## Legacy References

None found.

No imports of removed modules, no string references to removed APIs, no backwards-compatibility re-exports, no feature flags or environment-variable toggles for old/new behaviour were identified in the files reviewed.
