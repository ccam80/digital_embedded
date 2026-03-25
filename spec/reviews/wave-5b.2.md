# Review Report: Wave 5b.2 — Consumer Migration

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 9 (P5b-12 through P5b-20) |
| Violations — critical | 3 |
| Violations — major | 5 |
| Violations — minor | 2 |
| Gaps | 3 |
| Weak tests | 2 |
| Legacy references | 4 |

**Verdict**: has-violations

---

## Violations

### V-01 — CRITICAL: `isAnalogMode()` whole-circuit mode check survives in app-init.ts
- **File**: `src/app/app-init.ts`, lines 1858–1860, 1873, 1885, 1894, 1903, 524, 1544, 2380, 2553, 2567, 2773, 2837, 2842, 3029, 3405
- **Rule violated**: Phase 5b acceptance criterion — "Zero `isAnalogMode()` or equivalent whole-circuit mode check in consumer code" (spec §7 Acceptance Criteria); Code Hygiene rule — no feature flags or environment-variable toggles for old/new behaviour
- **Evidence**:
  ```typescript
  // line 1858–1860
  function isAnalogMode(): boolean {
    return (facade.getCoordinator()?.analogBackend ?? null) !== null;
  }
  ```
  Called at lines 524, 1544, 1873, 1885, 1894, 1903, 2380, 2553, 2567, 2773, 2837, 2842, 3029, 3405 — 14 call sites.
- **Severity**: critical

### V-02 — CRITICAL: `analogBackend` / `digitalBackend` accessed on coordinator in consumer code (app-init.ts)
- **File**: `src/app/app-init.ts`, lines 465, 1003, 1651, 1859, 1946, 1956, 1968, 2184, 2202, 2217, 2224, 2226, 2240, 2244, 2246, 2593
- **Rule violated**: Phase 5b acceptance criterion — "Zero `analogBackend` / `digitalBackend` in `SimulationCoordinator` interface (kept as private on concrete class)" and "Zero `coordinator.compiled.analog` or `coordinator.compiled.digital` reach-throughs in consumer code" (spec §7); Code Hygiene — no backwards compatibility shims
- **Evidence (sample)**:
  ```typescript
  // line 465
  return binding.isBound || ((facade.getCoordinator()?.analogBackend ?? null) !== null);
  // line 1946
  const analogEngine = coordinator.analogBackend;
  // line 1956
  if (coordinator.digitalBackend?.getState?.() === EngineState.RUNNING) return;
  // line 2226
  coordinator.digitalBackend?.microStep();
  // line 2246
  coordinator.digitalBackend?.runToBreak();
  ```
  Wave 5b.2 was supposed to remove all consumer-side backend reach-throughs. These are the exact patterns the spec defines as violations.
- **Severity**: critical

### V-03 — CRITICAL: `compiled.analog` reach-through in consumer code (app-init.ts)
- **File**: `src/app/app-init.ts`, lines 428, 540, 574, 1947, 2375, 2458, 2734, 2774, 2793, 3117
- **Rule violated**: Phase 5b acceptance criterion — "Zero `coordinator.compiled.analog` or `coordinator.compiled.digital` reach-throughs in consumer code" (spec §7 Acceptance Criteria)
- **Evidence (sample)**:
  ```typescript
  // line 428
  const analogCompiled = facade.getCoordinator()?.compiled.analog ?? null as ConcreteCompiledAnalogCircuit | null;
  // line 1947
  const analogCompiled = coordinator.compiled.analog ?? null;
  // line 2375
  const analogCompiled = facade.getCoordinator()?.compiled.analog ?? null;
  ```
  10 occurrences in app-init.ts alone.
- **Severity**: critical

### V-04 — MAJOR: `facade.getCompiled()` called in consumer code (app-init.ts)
- **File**: `src/app/app-init.ts`, lines 611, 620, 1054, 2374, 2474, 2792
- **Rule violated**: Phase 5b acceptance criterion — "Zero `getCompiled()` / `getCompiledAnalog()` dual accessors on facade" (spec §7); spec §2.2 specifies `getCompiled()` is removed and replaced with `getCompiledUnified()`
- **Evidence**:
  ```typescript
  // line 611
  const compiled = facade.getCompiled();
  // line 620
  const compiledCircuit = facade.getCompiled();
  // line 1054
  const compiled = facade.getCompiled();
  ```
  The spec requires `getCompiled()` to be deleted from the facade. These call sites confirm it either still exists or was not removed completely. (P5b-18 removed it from `default-facade.ts` but app-init.ts calls were not updated.)
- **Severity**: major

### V-05 — MAJOR: Raw `AnalogEngine` used in app-init.ts consumer code
- **File**: `src/app/app-init.ts`, lines 1995, 2400, 2599
- **Rule violated**: Phase 5b acceptance criterion — "Zero raw `AnalogEngine` or `SimulationEngine` parameters in runtime panel constructors (`DataTablePanel`, `AnalogScopePanel`, `TimingDiagramPanel`)" and "Zero raw `AnalogEngine` parameter in `WireCurrentResolver.resolve()` or `SliderEngineBridge` constructor" (spec §7)
- **Evidence**:
  ```typescript
  // line 1995 (function parameter)
  analogEngine: import('../core/analog-engine-interface.js').AnalogEngine,
  // line 2400
  const panel = new AnalogScopePanel(cvs, ae as unknown as import('../core/analog-engine-interface.js').AnalogEngine);
  // line 2599
  const result = (acEng as unknown as { acAnalysis(p: AcParams): ReturnType<import('../core/analog-engine-interface.js').AnalogEngine['acAnalysis']> }).acAnalysis(acParams);
  ```
  Line 2400 is particularly severe: `AnalogScopePanel` was migrated (P5b-13) to take `SimulationCoordinator`, but app-init.ts still passes an `AnalogEngine` via an `as unknown as` cast. This means the migration is cosmetic only — the actual call site was not updated.
- **Severity**: major

### V-06 — MAJOR: `@deprecated` tag on `getEngine()` in `DefaultSimulatorFacade`
- **File**: `src/headless/default-facade.ts`, line 313
- **Rule violated**: Code Hygiene — "No historical-provenance comments. Any comment describing what code replaced, what it used to do, why it changed, or where it came from is banned." The `@deprecated` marker is a direct backwards-compatibility shim marker — it explicitly acknowledges the method is a legacy accessor kept for compatibility.
- **Evidence**:
  ```typescript
  /** @deprecated Use getCoordinator() for typed access. Legacy accessor returning the coordinator as SimulationCoordinator | SimulationEngine union. */
  getEngine(): SimulationCoordinator | SimulationEngine | null {
    return this._coordinator;
  }
  ```
  The word "Legacy" in the comment also violates the historical-provenance ban explicitly ("any comment describing what code replaced"). P5b-18 required removing the old accessors, not marking them deprecated.
- **Severity**: major

### V-07 — MAJOR: `digitalBackend!` accessed in `SimulationRunner.compile()` — consumer reaching into coordinator backend
- **File**: `src/headless/runner.ts`, line 86
- **Rule violated**: Phase 5b acceptance criterion — backend properties are internal to the concrete class, never accessed in consumers (spec §1.12); same rule as V-02.
- **Evidence**:
  ```typescript
  this._records.set(coordinator.digitalBackend!, { coordinator });
  ```
  `SimulationRunner` is a consumer of the coordinator. Accessing `.digitalBackend` to register a WeakMap entry is backend reach-through.
- **Severity**: major

### V-08 — MINOR: `"fallback"` appears in `wire-current-resolver.ts` comment (code hygiene)
- **File**: `src/editor/wire-current-resolver.ts`, line 301
- **Rule violated**: Code Hygiene — no comments containing words like "fallback"
- **Evidence**:
  ```typescript
  // 2-terminal element (or fallback): single path pin0 → pin1
  ```
  The word "fallback" is explicitly on the banned comment word list in `spec/.context/rules.md`.
- **Severity**: minor

### V-09 — MINOR: Legacy comment on `SliderEngineBridge` file header referring to removed classes
- **File**: `src/editor/slider-engine-bridge.ts`, line 10
- **Rule violated**: Code Hygiene — "No historical-provenance comments. Any comment describing what code replaced … is banned."
- **Evidence**:
  ```
  * touches AnalogEngine or CompiledAnalogCircuit directly.
  ```
  The file-level comment describes what the bridge does NOT do in terms of removed types (`AnalogEngine`, `CompiledAnalogCircuit`). This is a historical-provenance remark — it describes what was replaced, not what the current code does.
- **Severity**: minor

---

## Gaps

### G-01: P5b-12 app-init.ts DataTablePanel call sites — partial completion acknowledged but scope unclear
- **Spec requirement**: P5b-12 requires app-init.ts `rebuildViewers()` to use `DataTablePanel(coordinator, signals)` with unified `addr`-based `SignalDescriptor`, single constructor call, no isAnalog branching.
- **What was found**: The progress.md entry for "P5b-12 (app-init.ts update)" claims this was completed during P5b-20, and grep shows `isAnalogMode()` still present at line 2380. The exact rebuildViewers() state is unverifiable without reading that block, but the presence of `isAnalogMode()` at line 2380 within close proximity suggests the branching was not fully eliminated.
- **File**: `src/app/app-init.ts`

### G-02: `getCompiled()` not deleted from `DefaultSimulatorFacade` — P5b-18 incomplete
- **Spec requirement**: P5b-18 / spec §2.2 states `getCompiled()` is removed and replaced with `getCompiledUnified()`. The facade must not expose a `getCompiled()` accessor.
- **What was found**: app-init.ts calls `facade.getCompiled()` at 6 locations (lines 611, 620, 1054, 2374, 2474, 2792). Either `getCompiled()` still exists in `default-facade.ts` (not evident from reading the file) or these are compile errors left unresolved. Either way, the spec-required removal is incomplete.
- **File**: `src/app/app-init.ts`, `src/headless/default-facade.ts`

### G-03: `AnalogScopePanel` call in app-init.ts still passes raw engine — P5b-13 migration incomplete at call site
- **Spec requirement**: P5b-13 / spec §4.7 requires `AnalogScopePanel(canvas, coordinator)` constructor — coordinator not engine. The file-level migration of `analog-scope-panel.ts` itself is correct, but the consumer (app-init.ts line 2400) passes `ae as unknown as AnalogEngine`, defeating the migration.
- **What was found**: `new AnalogScopePanel(cvs, ae as unknown as import('../core/analog-engine-interface.js').AnalogEngine)` — the cast is backwards; it should be passing the coordinator.
- **File**: `src/app/app-init.ts`, line 2400

---

## Weak Tests

### WT-01: `analog-scope-panel.test.ts` — `registers_as_observer_on_construction` accesses private `_observers` field
- **Test path**: `src/runtime/__tests__/analog-scope-panel.test.ts::AnalogScope::registers_as_observer_on_construction`
- **Problem**: The test verifies internal implementation detail (`_observers: Set<unknown>`) of the MockCoordinator rather than the observable behaviour (that `onStep` is called when the coordinator steps). This is a structural implementation test, not a behaviour test. If the coordinator changes its internal observer storage mechanism, the test breaks without the feature breaking.
- **Evidence**:
  ```typescript
  const observers = (coordinator as unknown as { _observers: Set<unknown> })._observers;
  expect(observers.has(panel)).toBe(true);
  ```
- **Severity**: minor

### WT-02: `timing-diagram.test.ts` — `clickToJump` test tracks internal `restoreCalls` array rather than observable state
- **Test path**: `src/runtime/__tests__/timing-diagram.test.ts::TimingDiagramPanel::clickToJump::restores the closest snapshot when jumpToTime is called`
- **Problem**: The test verifies that `restoreSnapshot` was called with a specific ID by checking an injected call-tracking array. While less severe than WT-01 (the behaviour being tested is "was the right snapshot restored?"), the assertion verifies call dispatch rather than actual engine state. If `restoreSnapshot` is a no-op but gets called with the right ID, the test passes. A stronger assertion would verify the resulting engine state or at minimum that the mock's state actually changed.
- **Evidence**:
  ```typescript
  const restoreCalls = getRestoreCalls();
  expect(restoreCalls.length).toBe(1);
  expect(restoreCalls[0]!.id).toBe(2);
  ```
- **Severity**: minor

---

## Legacy References

### LR-01: `src/headless/default-facade.ts`, line 313 — `@deprecated` and "Legacy" in comment
```typescript
/** @deprecated Use getCoordinator() for typed access. Legacy accessor returning the coordinator as SimulationCoordinator | SimulationEngine union. */
```
`@deprecated` and the word "Legacy" are historical-provenance markers. The method should be deleted, not annotated.

### LR-02: `src/headless/default-facade.ts`, lines 154–169 — "Legacy SimulationEngine path" comment
```typescript
} else {
  // Legacy SimulationEngine path (used by SimulationRunner)
  const engine = engineOrCoord as SimulationEngine;
```
"Legacy" is a banned word in comments. This comment describes a historical code path rather than explaining complicated logic.

### LR-03: `src/headless/runner.ts`, lines 150–165 — `runToStable()` contains a raw `engine.getSignalRaw()` path
```typescript
} else {
  const netCount = 64;
  for (let iter = 0; iter < maxIterations; iter++) {
    const before = new Uint32Array(netCount);
    for (let i = 0; i < netCount; i++) before[i] = engine.getSignalRaw(i);
```
This is a direct `engine.getSignalRaw()` call in a consumer file (`src/headless/runner.ts`). It is the exact pattern the spec's acceptance-criteria grep must return zero for. While P5b-17 improved the coordinator path, it retained this legacy `getSignalRaw` branch.

### LR-04: `src/editor/slider-engine-bridge.ts`, line 10 — reference to removed class names in file header
```
* touches AnalogEngine or CompiledAnalogCircuit directly.
```
Comment references `AnalogEngine` and `CompiledAnalogCircuit` — these are types that have been removed from consumer code. Documenting what the code no longer uses is a historical-provenance remark.
