# Phase 5: Simplify Consumers

**Goal**: Remove all analog-vs-digital branching from editor binding, app-init, and property panel. Remove `circuit.metadata.engineType`. All consumers interact with `SimulationCoordinator` and `SignalAddress` — no domain branching.

**Depends on**: Phase 4 (SimulationCoordinator exists and is wired into facade/runner).

**Note**: Phase 4 already completed facade task (P4-4) and runner task (P4-5) that the original spec listed as Phase 5 items 1-2. Those are done. This spec covers the remaining consumer simplification.

**Background**: Another agent is concurrently fixing Phase 4 review items (V1-V6, G1-G2, WT1-WT2). If you notice changes in facade/runner/coordinator that don't match the Phase 4 progress log, that's expected — don't revert or conflict with those changes.

---

## Wave 5.1 — EditorBinding + engineType removal

### P5-1: EditorBinding wireSignalMap migration (M)

**File**: `src/integration/editor-binding.ts`

**Current state**: EditorBinding stores `wireToNetId: Map<Wire, number>` for digital and uses a separate `wireSignalAccessAdapter` for analog. The `bind()` method branches on engine type.

**Target state** (from spec §8):
- Store `wireSignalMap: Map<Wire, SignalAddress>` (from `CompiledCircuit.wireSignalMap`)
- Store `labelSignalMap: Map<string, SignalAddress>` (from `CompiledCircuit.labelSignalMap`)
- `getWireSignal(wire)` reads `wireSignalMap.get(wire)` then `coordinator.readSignal(addr)` — no domain branching
- Wire renderer receives `SignalValue` and colors by `.type` (digital → HIGH/LOW/Z, analog → voltage gradient)

**Steps**:
1. Read `src/integration/editor-binding.ts` to understand current structure.
2. Read `src/compile/coordinator-types.ts` and `src/compile/types.ts` for `SignalAddress`, `SignalValue` types.
3. Replace `wireToNetId: Map<Wire, number>` with `wireSignalMap: Map<Wire, SignalAddress>`.
4. Replace `pinNetMap` with `labelSignalMap: Map<string, SignalAddress>`.
5. Update `bind()` to accept `CompiledCircuit` (or its wireSignalMap/labelSignalMap) + `SimulationCoordinator`.
6. Update `getWireSignal()` / `getWireValue()` to use `coordinator.readSignal(addr)`.
7. Remove all analog-vs-digital branching in the binding.
8. Update `src/integration/__tests__/editor-binding.test.ts` — tests should use SignalAddress/SignalValue.
9. Verify tests pass.

**Acceptance**:
- Zero `wireToNetId` or `wireToNodeId` references in editor-binding.ts
- `getWireSignal` returns `SignalValue`, not raw number
- All editor-binding tests pass

### P5-2: Remove circuit.metadata.engineType (M)

**Current state**: `circuit.metadata.engineType` is set to `"digital"`, `"analog"`, or `"auto"` and read in ~15 places across the codebase. With SimulationCoordinator, the engine type is derived from which backends are present — no declared tag needed.

**Target state**: `engineType` removed from circuit metadata. Consumers check `coordinator.digitalBackend !== null` / `coordinator.analogBackend !== null` instead.

**Steps**:
1. `grep -r "engineType" src/` to find all references.
2. In `src/core/circuit.ts` — remove `engineType` from `CircuitMetadata` interface (or mark as `@deprecated` for loader compat).
3. In `src/io/dig-parser.ts` — keep reading `engineType` from .dig XML for backwards compat, but don't store it on metadata. Instead, ignore it (the unified compiler derives the mode).
4. In `src/io/load.ts` / `src/io/save.ts` — keep serialization for backwards compat with existing .dig files, but loading ignores the value.
5. In `src/headless/default-facade.ts` — remove any `engineType` reads. The facade already uses `_coordinator`.
6. In `src/app/app-init.ts` — remove `isAnalogOrMixed()` and all `engineType` checks. (This overlaps with P5-3; coordinate by removing the metadata field here and letting P5-3 remove the branching logic.)
7. In `src/engine/flatten.ts` — remove `engineType` from `resolveCircuitDomain()` if it reads metadata.
8. Update tests that set `engineType` on circuits to instead rely on component model presence.
9. Verify tests pass.

**Acceptance**:
- Zero `metadata.engineType` reads in production code (loader/save may retain for file compat)
- `grep -r "engineType" src/ --include="*.ts" | grep -v test | grep -v __tests__ | grep -v ".d.ts"` returns only loader/save/deprecated compat code
- All tests pass

---

## Wave 5.2 — App-init + Property panel

### P5-3: App-init simplification (L)

**File**: `src/app/app-init.ts`

**Current state**: ~15 branch points on `engineType` or `getCompiledAnalog() !== null`:
- `isAnalogOrMixed()` check before compilation
- Separate `compileAndBind()` paths for digital vs analog
- Separate render loop startup
- Separate signal access for timing diagram vs analog scope
- Separate step logic
- Separate DC op / AC analysis menu visibility

**Target state** (from spec §7):
- One compilation path: `facade.compile(circuit)` returns coordinator
- One render loop: calls `coordinator.step()`
- Signal display via `EditorBinding.wireSignalMap` — no branching
- Step button calls `coordinator.step()`. Micro-step guarded by `coordinator.digitalBackend !== null`, not by mode
- Analog scope shown when `coordinator.analogBackend !== null` (one null check, not mode branch)
- DC op / AC analysis shown when `coordinator.analogBackend !== null`

**Steps**:
1. Read `src/app/app-init.ts` thoroughly.
2. Remove `isAnalogOrMixed()` function.
3. Unify `compileAndBind()` — one path that calls `facade.compile(circuit)`, gets coordinator, passes wireSignalMap to EditorBinding (depends on P5-1 being complete or compatible).
4. Unify render loop — remove separate `startAnalogRenderLoop` vs `startContinuousRun`. One loop that calls `coordinator.step()`.
5. Unify step button — `coordinator.step()`, with `coordinator.digitalBackend?.microStep()` for micro-step mode.
6. Remove all `if (engineType === 'analog')` branches.
7. Replace `getCompiledAnalog() !== null` checks with `coordinator.analogBackend !== null`.
8. Update tests in `src/app/__tests__/` if they exist.
9. Verify the app compiles and tests pass.

**Acceptance**:
- Zero `engineType` references in app-init.ts
- Zero `isAnalogOrMixed` function
- Zero `getCompiledAnalog()` calls in app-init.ts
- All analog/digital features still work (guarded by backend null checks, not mode flags)
- All tests pass

### P5-4: Property panel simulationModel dropdown (M)

**File**: `src/editor/property-panel.ts`

**Current state**: Property panel shows component properties but has no `simulationModel` dropdown. Multi-model components (e.g. AND gate with both digital and analog models) can't switch models via the UI.

**Target state** (from spec §1, Active Model Selection):
- If component has multiple models (`Object.keys(def.models).length > 1`), show a dropdown for `simulationModel` property
- Dropdown options: keys from `def.models` (e.g. "digital", "analog")
- Default: `def.defaultModel` or first key
- If component has exactly one model, hide the dropdown
- Property stored in component's `PropertyBag` as key `"simulationModel"`
- Changing the model triggers recompilation

**Steps**:
1. Read `src/editor/property-panel.ts` to understand current structure.
2. Read `src/core/registry.ts` for `ComponentModels`, `availableModels()`.
3. When a component with multiple models is selected, add a `simulationModel` dropdown at the top of the property list.
4. Dropdown values: `availableModels(def)` — the keys of `def.models`.
5. On change: update the component's `PropertyBag` with key `"simulationModel"`, trigger recompilation.
6. Hide dropdown for single-model components.
7. Add tests for the dropdown logic (not DOM rendering — test the data flow).
8. Verify tests pass.

**Acceptance**:
- Multi-model components show simulationModel dropdown in property panel
- Single-model components do not
- Changing the dropdown value updates PropertyBag and triggers recompilation
- Tests cover the dropdown logic

---

## Wave 5.3 — Verification

### P5-5: Full test suite verification + Phase 5 acceptance (S)

**Steps**:
1. Run full test suite (`npm test`).
2. Verify test count >= 7496 (Phase 4 baseline) with no new failures.
3. Grep verification:
   - `grep -r "engineType" src/ --include="*.ts"` — only in loader/save/deprecated compat
   - `grep -r "isAnalogOrMixed" src/` — zero hits
   - `grep -r "getCompiledAnalog" src/` — zero hits in app-init.ts
   - `grep -r "wireToNetId" src/` — zero hits in editor-binding.ts
4. Document results in progress.md.

**Acceptance**:
- All grep checks pass
- Test suite green (minus pre-existing 4 submodule failures)
- Net test count >= Phase 4 baseline
