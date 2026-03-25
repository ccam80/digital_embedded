# Review Report: Wave 5b.3 — App-init Unification

**Date**: 2026-03-26
**Tasks reviewed**: P5b-21, P5b-22, P5b-23, P5b-24, P5b-25, P5b-26, P5b-27
**Files changed**: `src/app/app-init.ts` (only)

---

## Summary

| Metric | Count |
|--------|-------|
| Tasks reviewed | 7 |
| Violations — critical | 3 |
| Violations — major | 4 |
| Violations — minor | 1 |
| Gaps | 2 |
| Weak tests | 0 |
| Legacy references | 2 |

**Verdict**: `has-violations`

---

## Violations

### V-1 — CRITICAL: Calls to non-existent methods `facade.getCompiled()` and `facade.getClockManager()`

- **File**: `src/app/app-init.ts`, lines 1002–1003
- **Rule violated**: Implementation completeness (rules.md — "Never mark work as deferred"); also violates spec §2.2 which replaced `getCompiled()` with `getCompiledUnified()`.
- **Evidence**:
  ```typescript
  const compiled = facade.getCompiled();
  const clockManager = facade.getClockManager();
  if (clockManager !== null && compiled !== null) {
    const netId = compiled.pinNetMap.get(`${elementHit.instanceId}:out`);
  ```
- **Severity**: critical
- **Reason**: `getCompiled()` is not defined on `DefaultSimulatorFacade` (the method was renamed `getCompiledUnified()` per spec §2.2; the old form was banned). `getClockManager()` is also not defined anywhere on `DefaultSimulatorFacade`. Both calls will return `undefined` at runtime (TypeScript may silently accept them due to `as unknown as …` casts elsewhere). This is a silent runtime failure for clock-toggle functionality. Additionally, `compiled.pinNetMap` is a solver-internal property on `ConcreteCompiledCircuit` — accessing it from consumer code is a reach-through violation (spec §1.11, acceptance criteria: "Zero direct `analogEngine.getNodeVoltage()` or `engine.getSignalRaw()` in consumer code" and "Zero `coordinator.compiled.analog` or `coordinator.compiled.digital` reach-throughs").

---

### V-2 — CRITICAL: `@deprecated` accessor `getEngine()` still used 15 times in consumer code

- **File**: `src/app/app-init.ts`, lines 500, 591–592, 1011, 1013, 1030, 1031, 1042, 1043, 2079, 2951, 3595, 3596, 3606, 3607, 4031, 4096, 5008, 5015, 5022, 5027
- **Rule violated**: Code hygiene (rules.md — "No backwards compatibility shims"); spec §1.2 removes direct engine reach-through; the `@deprecated` annotation on the method in `default-facade.ts` line 313 reads: "Legacy accessor returning the coordinator as SimulationCoordinator | SimulationEngine union."
- **Evidence**:
  ```typescript
  /** @deprecated Use getCoordinator() for typed access. Legacy accessor returning the coordinator as SimulationCoordinator | SimulationEngine union. */
  getEngine(): SimulationCoordinator | SimulationEngine | null {
  ```
  Called at e.g. line 500: `facade.getEngine()?.stop?.()`, line 591: `facade.getEngine()`, line 1011: `const eng = facade.getEngine()`, line 2079: `const eng = facade.getEngine()`, line 2951: `const memEng = facade.getEngine()`, line 3595: `const gifEng = facade.getEngine()`, lines 4031/4096 (snapshot budget), lines 5008/5015/5022/5027 (postmessage hooks).
- **Severity**: critical
- **Reason**: The existence of `@deprecated` alongside active usage is a backwards-compatibility shim. Per rules.md: "No backwards compatibility shims. No safety wrappers." The comment "Legacy accessor" is itself a historical-provenance comment, which is banned. The method should have been removed from the facade as part of this migration, and all call sites converted to `facade.getCoordinator()`.

---

### V-3 — CRITICAL: Historical-provenance comment on `getEngine()` in default-facade.ts

- **File**: `src/headless/default-facade.ts`, line 313
- **Rule violated**: rules.md — "No historical-provenance comments. Any comment describing what code replaced, what it used to do, why it changed, or where it came from is banned."
- **Evidence**:
  ```typescript
  /** @deprecated Use getCoordinator() for typed access. Legacy accessor returning the coordinator as SimulationCoordinator | SimulationEngine union. */
  ```
  The phrase "Legacy accessor" describes what this method used to be (a raw engine accessor that now returns a coordinator). This is a historical-provenance comment justifying the continued existence of a shim.
- **Severity**: critical
- **Reason**: A comment that describes why a deprecated shim exists is the canonical form of the banned historical-provenance comment. Per rules.md: "Read these as a signal that the agent knowingly failed to implement the new functionality cleanly and included a comment to make a shortcut seem acceptable."

---

### V-4 — MAJOR: `disposeViewers()` calls `removeMeasurementObserver` via `facade.getEngine()` cast instead of `coordinator`

- **File**: `src/app/app-init.ts`, lines 2079–2094
- **Rule violated**: Spec §3.9 (wire viewer uses coordinator); spec §1.2 (unified execution via coordinator); the acceptance criteria states "Zero raw `AnalogEngine` or `SimulationEngine` parameters in runtime panel constructors."
- **Evidence**:
  ```typescript
  function disposeViewers(): void {
    const eng = facade.getEngine();
    if (activeTimingPanel) {
      (eng as unknown as { removeMeasurementObserver(o: unknown): void } | null)?.removeMeasurementObserver(activeTimingPanel);
  ```
  The `SimulationCoordinator` interface has `removeMeasurementObserver(observer: MeasurementObserver): void` defined at `coordinator-types.ts` line 93. The coordinator should be used directly, not `getEngine()` cast through `unknown`.
- **Severity**: major
- **Reason**: This is a reach-through to the old engine interface via a `getEngine()` call that bypasses the coordinator contract. The double-cast `as unknown as { removeMeasurementObserver ... }` is a safety wrapper around a deprecated API. The coordinator method exists and could be used directly.

---

### V-5 — MAJOR: `stopSimulation()` falls back to `facade.getEngine()?.stop?.()` when coordinator is null

- **File**: `src/app/app-init.ts`, lines 1956–1963
- **Rule violated**: rules.md — "No fallbacks. No backwards compatibility shims. No safety wrappers."
- **Evidence**:
  ```typescript
  function stopSimulation(): void {
    if (runRafHandle !== -1) {
      cancelAnimationFrame(runRafHandle);
      runRafHandle = -1;
    }
    const coordinator = facade.getCoordinator();
    if (coordinator) {
      coordinator.stop();
    } else {
      facade.getEngine()?.stop?.();
    }
    scheduleRender();
  }
  ```
  The `else` branch is a backwards-compatibility fallback — it only executes when there is no coordinator, which means there is also no engine, so the `getEngine()` call returns the same `null` and `?.stop?.()` does nothing. But its presence is a shim that preserves the old direct-engine path.
- **Severity**: major
- **Reason**: Per rules.md, fallback branches are forbidden. The `else` branch should simply not exist. After Phase 5 and 5b, there is no scenario where a coordinator is null but an engine exists. The fallback masks incomplete migration.

---

### V-6 — MAJOR: `invalidateCompiled()` calls `facade.getEngine()` to check `EngineState.RUNNING`

- **File**: `src/app/app-init.ts`, lines 591–592
- **Rule violated**: Spec §3.7 — `isSimActive()` was unified to use `coordinator.getState() === EngineState.RUNNING`; direct `getEngine()` usage is forbidden in consumers.
- **Evidence**:
  ```typescript
  function invalidateCompiled(): void {
    compiledDirty = true;
    const eng = facade.getEngine();
    if ((eng as import("../core/engine-interface.js").SimulationEngine | null)?.getState?.() === EngineState.RUNNING) eng?.stop?.();
  ```
  This is a raw engine call that bypasses `isSimActive()` / `coordinator.getState()`.
- **Severity**: major
- **Reason**: The double-cast `as import(...).SimulationEngine | null` is a type-escape hatch on top of `getEngine()`. The spec prescribes `coordinator.getState() === EngineState.RUNNING` uniformly. Using `isSimActive()` (which exists and is correct) would have been sufficient.

---

### V-7 — MAJOR: `getEngine()` is called to pass a raw engine to `exportGif`, memory editor, sequential analysis, and snapshot budget

- **File**: `src/app/app-init.ts`, lines 2951–2953, 3595–3597, 4031, 4096, 4724–4734, 5008–5029
- **Rule violated**: Spec acceptance criteria — "Zero raw `AnalogEngine` or `SimulationEngine` parameters"; the deprecated `getEngine()` should not be used at all in consumer code.
- **Evidence** (representative):
  ```typescript
  // line 3595
  const gifEng = facade.getEngine();
  if (!gifEng || gifEng.getState?.() === EngineState.STOPPED) return;
  exportGif(circuit, gifEng).then(...)

  // line 2951
  const memEng = facade.getEngine();
  if (memEng?.getState?.() === EngineState.RUNNING) {
    editor.enableLiveUpdate(memEng);
  }

  // line 4031
  (facade.getEngine() as unknown as { setSnapshotBudget?(n: number): void } | null)?.setSnapshotBudget?.(...)

  // line 5008
  const engine = facade.getEngine();
  if (engine) { facade.step(engine); ... }
  ```
- **Severity**: major
- **Reason**: Multiple consumers still reach directly into the engine via the deprecated `getEngine()` accessor. These should use `facade.getCoordinator()` and the coordinator's unified API. The `as unknown as { setSnapshotBudget... }` cast on line 4031/4096 is a safety wrapper around a non-existent interface method — textbook banned shim. The postmessage hooks at lines 5008–5029 call `facade.step(engine)`, `facade.setInput(engine, ...)`, `facade.readOutput(engine, ...)` by passing a raw engine reference rather than using the coordinator.

---

### V-8 — MINOR: Comment "Fallback: return the raw message" in `_friendlyAnalogError`

- **File**: `src/app/app-init.ts`, line 478
- **Rule violated**: rules.md — comment uses the word "Fallback" which signals a fallback/backwards-compatibility code path.
- **Evidence**:
  ```typescript
  // Fallback: return the raw message
  return raw;
  ```
- **Severity**: minor
- **Reason**: "Fallback" is in the list of banned comment keywords per rules.md posture section. While the function is legitimate error-message translation, the comment describes the code path as a fallback rather than as "return unchanged message."

---

## Gaps

### G-1: `facade.getCompiled()` does not exist — spec §2.2 requires removal but the call site was not updated

- **Spec requirement**: §2.2 states: "Replace with a single accessor: `getCompiledUnified()`. Callers needing typed compiled data use `coordinator.compiled.digital` / `coordinator.compiled.analog` — but only inside `src/solver/` and `src/compile/`, never in consumers."
- **Found**: `facade.getCompiled()` is called at line 1002 but does not exist on `DefaultSimulatorFacade`. The spec-compliant path would be `coordinator.compiled.labelSignalMap` (for the netId lookup) via a coordinator-level method, since `pinNetMap` is a solver-internal property.
- **File**: `src/app/app-init.ts`, line 1002

### G-2: `facade.getClockManager()` does not exist — clock-phase sync for Clock toggle is incomplete

- **Spec requirement**: §1.5 states "ClockManager moves from the facade into `DefaultSimulationCoordinator`. The facade's `step()` calls `coordinator.advanceClocks()` before `coordinator.step()`." There is no `getClockManager()` on the facade after migration.
- **Found**: Line 1003 calls `facade.getClockManager()` which has no implementation anywhere. The clock-phase sync for manual Clock toggle (pointerdown on a Clock component during simulation) is silently broken — `clockManager` will always be `null` / `undefined` and the `setClockPhase` call never fires.
- **File**: `src/app/app-init.ts`, line 1003

---

## Weak Tests

None found. The tasks modified only `src/app/app-init.ts` (browser-only code). No new test files were created in this wave. The completion report states 7655/7659 passing — test count unchanged from pre-wave baseline.

---

## Legacy References

### L-1: `@deprecated` tag with "Legacy accessor" comment on `getEngine()` in default-facade.ts

- **File**: `src/headless/default-facade.ts`, line 313
- **Evidence**: `/** @deprecated Use getCoordinator() for typed access. Legacy accessor returning the coordinator as SimulationCoordinator | SimulationEngine union. */`
- **Note**: This is also reported as V-3 (critical violation). Listed here for completeness as a legacy reference.

### L-2: Comment "Legacy accessors used by engine consumers" in splitter.ts

- **File**: `src/components/wiring/splitter.ts`, line 216
- **Evidence**: `// Legacy accessors used by engine consumers`
- **Note**: This file was not modified in wave 5b.3, so this is a pre-existing legacy reference, not introduced by this wave. Flagged for completeness. Not attributable to this wave's implementation agent.

---

## Notes on Scope

The completion report stated "Grep verification: zero hits for `isAnalogMode`, `analogBackend`/`digitalBackend`, `compiled.analog`/`compiled.digital` in app-init.ts." This is confirmed correct for those specific patterns. The violations found in this review are in areas not covered by the stated grep verification:

1. `facade.getCompiled()` / `facade.getClockManager()` — banned dual accessors that no longer exist (call sites not updated)
2. `facade.getEngine()` — deprecated shim kept alive with a historical-provenance comment; used in 15+ places in app-init.ts and passed to GIF export, memory editor, sequential analysis, postmessage hooks
3. `disposeViewers()` — observer removal via `getEngine()` cast instead of `coordinator.removeMeasurementObserver()`
4. `invalidateCompiled()` — `getState()` check via `getEngine()` cast instead of `coordinator.getState()`

The task P5b-21 through P5b-27 spec requirements for the render loop unification, visualization extraction, button handler unification, speed control, and wire viewer are all implemented correctly. The violations are concentrated in peripheral paths (clock toggle, viewer disposal, GIF export, memory editor, postmessage hooks, sequential analysis, snapshot budget) that were not part of the core task scope but were touched by the implementation agent and left in a broken/shim state.
