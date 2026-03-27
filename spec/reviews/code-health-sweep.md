# Code Health Sweep — Duplication, Coupling, Modularity, Dead Code

**Date:** 2025-03-28
**Scope:** `src/` directory — all production code
**Rule:** Test-only usage is NOT evidence of live code. Test-only exports are flagged as potential dead code.

---

## Table of Contents

1. [Severity Legend](#severity-legend)
2. [Duplication Findings](#1-duplication)
3. [Coupling Findings](#2-coupling)
4. [Modularity Findings](#3-modularity)
5. [Dead & Test-Only Code](#4-dead--test-only-code)
6. [Fix Spec — Ordered by Priority](#5-fix-spec)

---

## Severity Legend

| Level | Meaning |
|-------|---------|
| **P0** | Bug-divergence risk or architectural violation — fix before next feature wave |
| **P1** | Maintenance burden, slows debugging — fix in dedicated cleanup sprint |
| **P2** | Papercut / cosmetic — fix opportunistically |

---

## 1. Duplication

### D1 — Analog MNA stamp helpers (P0)

`stampG()` and `stampRHS()` are copy-pasted as file-local functions in **21 locations** across 18 files. The capacitor file already shows divergence (renamed to `capStampG`/`capStampRHS` with identical logic).

```
src/components/passives/resistor.ts:154      src/components/semiconductors/diode.ts:53
src/components/passives/capacitor.ts:134     src/components/semiconductors/zener.ts:42
src/components/passives/crystal.ts           src/components/semiconductors/varactor.ts
src/components/passives/polarized-cap.ts     src/components/semiconductors/tunnel-diode.ts
src/components/passives/memristor.ts         src/components/semiconductors/diac.ts
src/components/passives/transmission-line.ts src/components/semiconductors/bjt.ts
src/components/semiconductors/mosfet.ts      src/components/semiconductors/njfet.ts
src/components/semiconductors/pjfet.ts       src/components/semiconductors/triode.ts
src/components/semiconductors/triac.ts       src/components/semiconductors/scr.ts
src/solver/analog/fet-base.ts
```

**Fix:** Create `src/solver/analog/stamp-helpers.ts` exporting `stampG` and `stampRHS`. Replace all 21 file-local copies with imports.

### D2 — Gate component scaffolding (P0)

All 7 gate files (`and`, `or`, `nand`, `nor`, `xor`, `xnor`, `not`) clone ~750 lines of identical logic:

| Block | Per-file LOC | Copies | Total waste |
|-------|-------------|--------|-------------|
| `compWidth()` + `componentHeight()` + `buildInputLabels()` + `buildPinDeclarations()` | ~22 | 7 | ~154 |
| `PropertyDefinition[]` array (identical 5 entries) | ~30 | 6 | ~180 |
| `AttributeMapping[]` array (identical 5 entries) | ~22 | 6 | ~132 |
| `_drawLabel()` method | ~7 | 7 | ~49 |
| `draw()` extension-line block | ~12 | 6 | ~72 |
| IEEE body shapes (AND=NAND, OR=NOR, XOR=XNOR — byte-identical pairs) | ~20 | 3 pairs | ~60 |

**Fix:** Create `src/components/gates/gate-shared.ts`:
- Export `compWidth`, `componentHeight`, `buildInputLabels`, `buildPinDeclarations`
- Export `STANDARD_GATE_PROPERTY_DEFS`, `STANDARD_GATE_ATTRIBUTE_MAPPINGS`
- Export `drawGateExtensionLines`, `drawGateLabel`
- Export `drawAndBody`, `drawOrBody`, `drawXorBody` (shared by X/NX pairs)

### D3 — Analog lead-wire voltage coloring (P1)

The 5-line voltage-color-then-draw pattern is repeated **35+ times** across 11 semiconductor files plus passives:

```typescript
if (signals && vA !== undefined) {
  ctx.setRawColor(signals.voltageColor(vA));
} else {
  ctx.setColor("COMPONENT");
}
ctx.drawLine(x1, y1, x2, y2);
```

**Fix:** Extract `drawColoredLead(ctx, signals, voltage, x1, y1, x2, y2)` to `src/components/draw-helpers.ts`.

### D4 — `makeExecuteX` / `executeX` in-file duplication (P1)

`add.ts` and `sub.ts` each have both a closure-factory (`makeExecuteAdd`) and a standalone (`executeAdd`) with duplicated arithmetic logic in the same file.

**Fix:** Have `executeAdd` delegate to `makeExecuteAdd(props.bitWidth)` instead of duplicating the body.

### D5 — `getHelpText()` / `helpText` double-maintenance (P2)

Every component defines `getHelpText()` returning the same string that appears in the `ComponentDefinition.helpText` property. ~130 files affected.

**Fix:** Have `getHelpText()` return `undefined` and fall back to the registry definition's `helpText`.

### D6 — `LABEL_PROPERTY_DEF` repeated everywhere (P2)

The identical `{ key: "label", type: PropertyType.STRING, label: "Label", defaultValue: "", description: "..." }` object appears in virtually every component file.

**Fix:** Export a shared `LABEL_PROPERTY_DEF` constant from `src/core/properties.ts`.

---

## 2. Coupling

### C1 — `core/circuit.ts` imports from `editor/wire-merge.ts` (P0)

Circular dependency: `core/circuit.ts:14` imports `mergeCollinearSegments` from `../editor/wire-merge.js`, and `wire-merge.ts:9` imports `Wire` from `@/core/circuit`. Core depends on editor.

**Fix:** Move `mergeCollinearSegments` to `src/core/wire-utils.ts`. It is a pure geometric function on `Wire[]`.

### C2 — `core/element.ts` imports `PinVoltageAccess` from `editor/` (P0)

`core/element.ts:15` imports `PinVoltageAccess` from `../editor/pin-voltage-access.ts`. This type is used in the `draw()` signature of `CircuitElement` and `AbstractCircuitElement`, creating a core-to-editor dependency referenced by 46+ files.

**Fix:** Move `PinVoltageAccess` to `src/core/pin-voltage-access.ts`. It is a 2-method read-only interface with no editor-specific behavior.

### C3 — `core/registry.ts` imports solver/analog internals (P0)

`core/registry.ts:13-14` imports `AnalogElementCore` and `DeviceType` from `../solver/analog/`. The registry is the foundational catalog — everything imports it, so this creates a transitive dependency on analog solver internals across the entire codebase.

**Fix:** Define `AnalogElementCore` and `DeviceType` as interfaces/types in `src/core/analog-types.ts`. Solver implements them.

### C4 — `core/analog-engine-interface.ts` imports `AcParams`/`AcResult` from solver (P1)

`core/analog-engine-interface.ts:15` imports from `../solver/analog/ac-analysis.js`.

**Fix:** Move `AcParams` and `AcResult` type definitions to `src/core/analog-types.ts` alongside the `AnalogEngine` interface.

### C5 — Circular `compile/ <-> solver/analog/compiler` (P0)

`compile/compile.ts:30` imports `compileAnalogPartition` from `solver/analog/compiler.ts`. `solver/analog/compiler.ts:41` imports `compileUnified` from `compile/compile.ts`. Runtime circular dependency.

**Fix:** The analog compiler's `compileInnerDigitalCircuit()` should receive a digital-compiler callback as a parameter, not call back to `compileUnified`.

### C6 — Global mutable RAM backing stores (P1)

`src/components/memory/ram.ts:111-133` owns a module-level `Map<number, DataField>` (`_backingStores`). The digital engine at `digital-engine.ts:36` imports and mutates it directly. Concurrent engines would corrupt each other.

**Fix:** Scope backing stores per engine instance. Pass a `BackingStoreManager` to the engine constructor; components receive a reference during compilation.

### C7 — `compile/` imports `Diagnostic` from `headless/` (P1)

`compile/compile.ts:39`, `compile/extract-connectivity.ts:14`, `compile/types.ts:15` import `Diagnostic` from the higher-level `headless/netlist-types.ts`.

**Fix:** Move `Diagnostic` and `DiagnosticCode` to `src/core/diagnostic.ts` (or `compile/types.ts` as canonical home).

### C8 — 50+ component files import solver/analog internals (P2)

Analog-native components (`led.ts`, `mosfet.ts`, `scr.ts`, etc.) directly import `SparseSolver`, `pnjlim`, `fetlim`, and other solver implementation types. The behavioral gate factories properly abstract this — analog-native components bypass it.

**Fix (future):** Define an analog model SPI in `core/analog-model-spi.ts`. Components program against it; solver provides the implementation. This is a large refactor — defer until a solver replacement is actually planned.

---

## 3. Modularity

### M1 — `initCanvasInteraction()` is a 918-line function (P1)

`src/app/canvas-interaction.ts:121` — bundles hit-test constants, drag state machine, pointer tracking, popup state, subcircuit navigation, memory editor, wire completion, pointer events, wheel zoom, and double-click handling.

**Fix:** Extract into focused handlers: `PointerDragHandler`, `SubcircuitNavigationHandler`, `MemoryEditorHandler`, `WheelZoomHandler`, `DoubleClickHandler`. The existing section comments mark natural boundaries.

### M2 — `compileAnalogCircuit()` is 970 lines (P1)

`src/solver/analog/compiler.ts:667` — performs 5+ pipeline stages (node-map building, element stamping, VDD injection, topology validation, assembly) in one function.

**Fix:** Extract each numbered step into a named function: `buildNodeMap()`, `stampElements()`, `injectVddSource()`, `validateTopology()`, `assembleCompiledCircuit()`. Same for `compileAnalogPartition()` (698 lines at line 1773).

### M3 — `initMenuAndToolbar()` is ~1070 lines (P1)

`src/app/menu-toolbar.ts:84` — constructs menus, toolbar buttons, simulation controls, file operations, export dialogs, and dark mode in one closure block with 72 direct DOM calls.

**Fix:** Extract menu sections into builder functions: `buildInsertMenu()`, `buildContextMenu()`, `buildExportDialogs()`, `buildSimulationControls()`.

### M4 — `behavioral-flipflop-variants.ts` is 1158 lines (P2)

7 flip-flop variant factories in one file (JK, RS, T, D-async, JK-async, RS-async, monoflop). Each is self-contained.

**Fix:** Split into `src/solver/analog/behavioral-flipflop/{jk,rs,t,d-async,jk-async,rs-async,monoflop}.ts`.

### M5 — `PREVIEW_GRID = 20` duplicates `GRID_SPACING` (P2)

`src/app/subcircuit-dialog.ts:44` redefines what is already `GRID_SPACING` from `src/editor/coordinates.ts:11`.

**Fix:** Import `GRID_SPACING` instead.

### M6 — Simulation constants scattered inline (P2)

| Constant | Location | Value |
|----------|----------|-------|
| `MAX_STEPS` | `digital-engine.ts:399` | `100_000` |
| `MAX_INPUT_BITS` | `model-analyser.ts:58` | `20` |
| `MAX_DEPTH` | `subcircuit-loader.ts:32` | `30` |

**Fix:** Centralize in `src/core/constants.ts`.

---

## 4. Dead & Test-Only Code

### 4a. Truly DEAD (zero consumers anywhere)

| Symbol | File | Action |
|--------|------|--------|
| `duplicate()` | `src/editor/edit-operations.ts:369` | Delete |
| `DEFAULT_LEVEL_CONFIG` | `src/solver/digital/evaluation-mode.ts:53` | Delete |
| `DEFAULT_TIMED_CONFIG` | `src/solver/digital/evaluation-mode.ts:55` | Delete |
| `DEFAULT_MICROSTEP_CONFIG` | `src/solver/digital/evaluation-mode.ts:60` | Delete |
| `defaultConfigForMode()` | `src/solver/digital/evaluation-mode.ts:65` | Delete |
| `ParseError` | `src/analysis/expression-parser.ts:34` | Delete |
| `EngineFactory` (type) | `src/headless/runner.ts:26` | Delete |
| `RedrawCoordinator` | `src/integration/redraw-coordinator.ts:36` | Delete (only used in own file) |

### 4b. INTERNAL-ONLY (exported but only used within their own file — unexport)

| Symbol | File |
|--------|------|
| `StepOptions` | `src/headless/default-facade.ts:48` |
| `manhattanSegments` | `src/editor/wire-drawing.ts:342` |
| `GhostState` | `src/editor/placement.ts:27` |
| `CardinalFace` | `src/core/pin.ts:226` |
| `RepaintCallback` | `src/integration/redraw-coordinator.ts:19` |
| `RafProvider` | `src/integration/redraw-coordinator.ts:26` |
| `OverlayKind` | `src/runtime/analog-scope-panel.ts:36` |
| `parseAddress` | `src/headless/address.ts:41` |
| `buildLabelIndex` | `src/headless/address.ts:61` |
| `drawCursors` | `src/runtime/scope-cursor-renderer.ts:20` |
| `drawMeasurementPanel` | `src/runtime/scope-cursor-renderer.ts:77` |

### 4c. TEST-ONLY — triaged

Investigation notes:
- `BacktrackException`, `NodeException`, `PinException` are **never thrown** anywhere in production. Only `BitsException`, `BurnException`, `OscillationError` are actually used. These three are pure clutter.
- K-map: `KarnaughMapTab` IS wired into the Analysis dialog (`analysis-dialogs.ts:124`). `grayCodeSequence`, `cycleValue`, `KMapRenderContext` are used by it. Only `grayCodeIndex` is orphaned.
- Expression modifiers (`toNandOnly` etc.): NOT used by `synthesis.ts` or any production path — synthesis builds only basic And/Or/Not gates.
- `autoConnectPower`: IS wired into Edit menu via `analysis-dialogs.ts` → `btn-auto-power`. User wants it deleted from all levels.
- `AnalogRateController`: superseded by `SpeedControl` + `coordinator.computeFrameSteps()`.
- `loadProgram` + `program-formats.ts`: not duplicated elsewhere — unique code path for loading programs into memory components.

#### SURFACE — wire into UI (keep code + tests, add UI integration)

| Symbol | File | What to wire |
|--------|------|--------------|
| `computeStatistics` | `src/analysis/statistics.ts:54` | Add "Circuit Statistics" panel/dialog |
| `toNandOnly` / `toNorOnly` / `limitFanIn` / `isNandOnly` / `isNorOnly` | `src/analysis/expression-modifiers.ts` | Wire into synthesis dialog options |
| `MonteCarloRunner` / `SeededRng` / `computeOutputStatistics` | `src/solver/analog/monte-carlo.ts` | Add Monte Carlo analysis dialog |
| `ParameterSweepRunner` / `generateSweepValues` | `src/solver/analog/parameter-sweep.ts` | Add Parameter Sweep dialog |
| `buildFrequencyArray` | `src/solver/analog/ac-analysis.ts:294` | Used by parameter sweep / AC tooling |
| `captureRuntimeToDefaults` / `restoreAllFuses` | `src/editor/runtime-to-defaults.ts` | Add Edit menu entries |
| `autoNumberLabels` | `src/editor/label-tools.ts` | Add Edit menu entry |
| `FileHistory` | `src/editor/file-history.ts:25` | Wire into File menu recent-files list |
| `loadProgram` + format helpers | `src/runtime/program-loader.ts`, `program-formats.ts` | Wire into memory component context menu |

#### DELETE — remove code + tests

| Symbol | File | Reason |
|--------|------|--------|
| `SimulationRunner` (class) | `src/headless/runner.ts:46` | Superseded by `DefaultSimulatorFacade`; migrate 15 test files |
| `TestRunner` (class) | `src/headless/test-runner.ts:37` | Superseded by facade's `runTests()` |
| `captureTrace` | `src/headless/trace.ts:29` | Test-only debug utility |
| `BacktrackException` | `src/core/errors.ts:80` | Never thrown anywhere |
| `NodeException` | `src/core/errors.ts:142` | Never thrown anywhere |
| `PinException` | `src/core/errors.ts:200` | Never thrown anywhere |
| `PropertyBagSchema` | `src/core/properties.ts:150` | Test-only Zod schema |
| `propertyBagFromJson` | `src/core/properties.ts:158` | Test-only deserializer |
| `PropertyDefinitionSchema` | `src/core/properties.ts:179` | Test-only Zod schema |
| `defaultCircuitMetadata` | `src/core/circuit.ts:129` | Test-only helper |
| `isPinInverted` | `src/core/pin.ts:73` | Test-only helper |
| `analyseDependencies` | `src/analysis/dependency.ts:47` | Unused analysis |
| `substituteForAnalysis` | `src/analysis/substitute-library.ts:83` | Unused analysis |
| `exprToLatex` | `src/analysis/expression.ts:172` | Unused formatter |
| `exportCsv` / `importCsv` / `exportHex` / `exportLatex` / `exportTestCase` / `loadTru` / `saveTru` | `src/analysis/truth-table-io.ts` | Not wired to any UI |
| `grayCodeIndex` | `src/analysis/karnaugh-map.ts:44` | Orphan (other kmap exports are live) |
| `quickRun` / `speedTest` | `src/solver/digital/quick-run.ts` | Benchmark-only |
| `shuffleArray` | `src/solver/digital/noise-mode.ts:27` | Test-only |
| `MicroStepController` | `src/solver/digital/micro-step.ts:52` | Test-only |
| `resolveDelays` | `src/solver/digital/delay.ts:32` | Test-only |
| `canUseWorkerEngine` / `createEngine` | `src/solver/digital/worker-detection.ts` | Test-only |
| `WorkerEngine` | `src/solver/digital/worker-engine.ts:92` | Test-only |
| `test-elements.ts` (entire file) | `src/solver/analog/test-elements.ts` | Move to test-utils/ (test-only factories) |
| `addLabelPrefix` / `removeLabelPrefix` / `renameTunnel` | `src/editor/label-tools.ts` | Unused (keep `autoNumberLabels`) |
| `autoConnectPower` / `findUnconnectedPowerPins` (+ all support) | `src/editor/auto-power.ts` | Delete feature from all levels (UI button, function, tests) |
| `distancePointToSegment` | `src/editor/hit-test.ts:172` | Test-only |
| `isPointOnSegmentInterior` | `src/editor/wire-drawing.ts:31` | Test-only |
| `PowerOverlay` | `src/editor/power-overlay.ts:39` | Test-only |
| `RecordingContext` | `src/runtime/waveform-renderer.ts:64` | Test-only |
| `MeasurementOrderPanel` | `src/runtime/measurement-order.ts:62` | Test-only |
| `SingleValueDialog` | `src/runtime/value-dialog.ts:31` | Test-only |
| `AnalogRateController` / `FrameTarget` / `FrameResult` / `AnalogRateConfig` | `src/integration/analog-rate-controller.ts` | Superseded by `SpeedControl` + coordinator |
| `EngineFactory` (type) | `src/headless/runner.ts:26` | Dead type |

---

## 5. Fix Spec — Ordered by Priority

### Wave 0 — Architectural violations (P0, do first)

| ID | Task | Files touched | LOC delta |
|----|------|---------------|-----------|
| F1 | Extract `stampG`/`stampRHS` to `src/solver/analog/stamp-helpers.ts` | 18 component files + 1 new | -80 net |
| F2 | Move `mergeCollinearSegments` to `src/core/wire-utils.ts` | `core/circuit.ts`, `editor/wire-merge.ts` → `core/wire-utils.ts` | ~0 |
| F3 | Move `PinVoltageAccess` to `src/core/pin-voltage-access.ts` | `core/element.ts` + 46 import updates | ~0 |
| F4 | Move `AnalogElementCore`, `DeviceType` to `src/core/analog-types.ts` | `core/registry.ts`, solver/analog files | ~0 |
| F5 | Break `compile ↔ solver/analog/compiler` cycle — inject digital-compiler callback | `compile/compile.ts`, `solver/analog/compiler.ts` | ~+10 |
| F6 | Create `src/components/gates/gate-shared.ts` with shared helpers + constants | 7 gate files + 1 new | -500 net |

### Wave 1 — Maintenance burden (P1)

| ID | Task | Files touched | LOC delta |
|----|------|---------------|-----------|
| F7 | Extract `drawColoredLead()` helper | 11 semiconductor + passive files + 1 new | -120 net |
| F8 | Fix `makeExecuteAdd`/`executeAdd` duplication (and sub) | `add.ts`, `sub.ts` | -40 net |
| F9 | Move `AcParams`/`AcResult` to `src/core/analog-types.ts` | `core/analog-engine-interface.ts`, `solver/analog/ac-analysis.ts` | ~0 |
| F10 | Move `Diagnostic`/`DiagnosticCode` to `src/core/diagnostic.ts` | `compile/types.ts`, `headless/netlist-types.ts` + consumers | ~0 |
| F11 | Scope RAM backing stores per engine | `ram.ts`, `digital-engine.ts` | ~+30 |
| F12 | Split `initCanvasInteraction` into focused handlers | `canvas-interaction.ts` → 5 files | ~+40 (imports) |
| F13 | Split `compileAnalogCircuit` into pipeline functions | `solver/analog/compiler.ts` | ~+20 (signatures) |
| F14 | Split `initMenuAndToolbar` into builder functions | `menu-toolbar.ts` → 4-5 files | ~+30 (imports) |
| F15 | Delete truly dead code (Section 4a) | 5 files | -60 net |
| F16 | Unexport internal-only symbols (Section 4b) | 8 files | ~0 |

### Wave 2 — Papercuts (P2)

| ID | Task | Files touched | LOC delta |
|----|------|---------------|-----------|
| F17 | Extract shared `LABEL_PROPERTY_DEF` constant | `core/properties.ts` + 130 component files | -260 net |
| F18 | Eliminate `getHelpText()`/`helpText` duplication | Component base class + 130 files | -260 net |
| F19 | Import `GRID_SPACING` instead of `PREVIEW_GRID` | `subcircuit-dialog.ts` | -1 |
| F20 | Centralize simulation constants | 4 files + 1 new `core/constants.ts` | ~0 |
| F21 | Split `behavioral-flipflop-variants.ts` into per-variant files | 1 file → 7 files | ~+30 (imports) |
### Wave 3 — Dead code deletion (from Section 4c DELETE list)

| ID | Task | Files touched | LOC delta |
|----|------|---------------|-----------|
| F22 | Delete `BacktrackException`, `NodeException`, `PinException` + tests | `core/errors.ts`, `errors.test.ts`, `headless/index.ts` re-exports | -120 net |
| F23 | Delete `SimulationRunner` class, migrate 15 test files to `DefaultSimulatorFacade` | `headless/runner.ts` + 15 test files | -200 net |
| F24 | Delete `TestRunner` class + test | `headless/test-runner.ts` | -80 net |
| F25 | Delete `captureTrace` + test | `headless/trace.ts` | -60 net |
| F26 | Delete `PropertyBagSchema`, `propertyBagFromJson`, `PropertyDefinitionSchema` + tests | `core/properties.ts` | -40 net |
| F27 | Delete `defaultCircuitMetadata`, `isPinInverted` exports + tests | `core/circuit.ts`, `core/pin.ts` | -20 net |
| F28 | Delete `analyseDependencies` + `substituteForAnalysis` + tests | `analysis/dependency.ts`, `analysis/substitute-library.ts` | -150 net |
| F29 | Delete `exprToLatex` + test | `analysis/expression.ts` | -30 net |
| F30 | Delete all `truth-table-io.ts` exports + tests | `analysis/truth-table-io.ts` | -200 net |
| F31 | Delete `grayCodeIndex` export (keep other kmap exports — they're live) | `analysis/karnaugh-map.ts` | -5 net |
| F32 | Delete `quickRun`/`speedTest` + test | `solver/digital/quick-run.ts` | -80 net |
| F33 | Delete `shuffleArray`, `MicroStepController`, `resolveDelays` + tests | `noise-mode.ts`, `micro-step.ts`, `delay.ts` | -100 net |
| F34 | Delete `WorkerEngine`, `canUseWorkerEngine`, `createEngine` + tests | `worker-engine.ts`, `worker-detection.ts` | -150 net |
| F35 | Move `test-elements.ts` to `src/solver/analog/__tests__/test-helpers.ts` | 1 file move + 15 test import updates | ~0 |
| F36 | Delete `addLabelPrefix`, `removeLabelPrefix`, `renameTunnel` + tests (keep `autoNumberLabels`) | `editor/label-tools.ts` | -60 net |
| F37 | Delete `autoConnectPower` feature from ALL levels: function, `btn-auto-power` UI wiring in `analysis-dialogs.ts`, `auto-power.ts`, tests | `editor/auto-power.ts`, `app/analysis-dialogs.ts` | -200 net |
| F38 | Delete `distancePointToSegment`, `isPointOnSegmentInterior`, `PowerOverlay` + tests | `hit-test.ts`, `wire-drawing.ts`, `power-overlay.ts` | -80 net |
| F39 | Delete `RecordingContext`, `MeasurementOrderPanel`, `SingleValueDialog` + tests | `waveform-renderer.ts`, `measurement-order.ts`, `value-dialog.ts` | -120 net |
| F40 | Delete `AnalogRateController` + all exports + tests | `integration/analog-rate-controller.ts` | -150 net |

### Wave 4 — Surface features (from Section 4c SURFACE list)

These are code paths that exist and are tested but lack UI integration. Each needs a menu entry, dialog, or context-menu hook.

| ID | Task | What to wire | Files touched |
|----|------|--------------|---------------|
| F41 | Wire `computeStatistics` into Analysis dialog | "Circuit Statistics" tab or status bar | `analysis-dialogs.ts` |
| F42 | Wire expression modifiers into synthesis dialog | NAND-only / NOR-only / fan-in-limit options | `analysis-dialogs.ts` or new synthesis UI |
| F43 | Wire `MonteCarloRunner` into Analysis dialog | Monte Carlo analysis panel | New dialog + `app/` wiring |
| F44 | Wire `ParameterSweepRunner` + `buildFrequencyArray` | Parameter Sweep dialog | New dialog + `app/` wiring |
| F45 | Wire `captureRuntimeToDefaults` / `restoreAllFuses` into Edit menu | "Capture Defaults" / "Restore Fuses" menu items | `menu-toolbar.ts` |
| F46 | Wire `autoNumberLabels` into Edit menu | "Auto-Number Labels" menu item | `menu-toolbar.ts` |
| F47 | Wire `FileHistory` into File menu | Recent files submenu | `menu-toolbar.ts` |
| F48 | Wire `loadProgram` + format helpers into memory component context menu | "Load Program..." context menu item | `canvas-interaction.ts` or property panel |

### Dependency order within waves

Wave 0: F4 before F5 (analog types must exist before compiler refactor). F1-F3, F6 are independent.

Wave 1: F9-F10 are independent type moves. F11 is independent. F12-F14 are independent of each other. F7-F8 are independent.

Wave 2: All independent.

Wave 3: F23 is the largest (15 test file migrations). F37 touches UI wiring. All others are independent leaf deletions. Do F23 first to avoid conflicts.

Wave 4: All independent. Each is a self-contained UI wiring task.

---

## Estimated Total Impact

| Metric | Before | After (all waves) |
|--------|--------|--------------------|
| Duplicated stamp helper copies | 21 | 1 |
| Duplicated gate scaffolding LOC | ~750 | ~50 |
| Core → editor/solver upward imports | 4 | 0 |
| Circular dependency chains | 2 | 0 |
| Truly dead exports | 8 + 30 triaged | 0 |
| Internal-only exports leaking | 11 | 0 |
| Functions over 500 lines | 4 | 0 |
| Test-only code surfaced as features | 0 | 8 new UI entries |
| Net LOC reduction (waves 0-3) | — | ~-2,800 |
