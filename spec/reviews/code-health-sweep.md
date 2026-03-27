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

### 4c. TEST-ONLY — potential dead code (user to triage: delete vs surface in UI)

#### Headless / Core

| Symbol | File | Test consumer(s) |
|--------|------|-------------------|
| `SimulationRunner` (class) | `src/headless/runner.ts:46` | 15+ test files, 2 dev scripts |
| `TestRunner` (class) | `src/headless/test-runner.ts:37` | `test-runner.test.ts` |
| `captureTrace` | `src/headless/trace.ts:29` | `trace.test.ts`, `integration.test.ts` |
| `BacktrackException` | `src/core/errors.ts:80` | `errors.test.ts` (re-exported by `headless/index.ts`) |
| `NodeException` | `src/core/errors.ts:142` | `errors.test.ts` |
| `PinException` | `src/core/errors.ts:200` | `errors.test.ts` |
| `PropertyBagSchema` | `src/core/properties.ts:150` | `properties.test.ts` |
| `propertyBagFromJson` | `src/core/properties.ts:158` | `properties.test.ts` |
| `PropertyDefinitionSchema` | `src/core/properties.ts:179` | `properties.test.ts` |
| `defaultCircuitMetadata` | `src/core/circuit.ts:129` | `circuit.test.ts` |
| `isPinInverted` | `src/core/pin.ts:73` | `pin.test.ts` |

#### Analysis

| Symbol | File | Test consumer(s) |
|--------|------|-------------------|
| `analyseDependencies` | `src/analysis/dependency.ts:47` | `dependency.test.ts` |
| `substituteForAnalysis` | `src/analysis/substitute-library.ts:83` | `substitute-library.test.ts` |
| `computeStatistics` | `src/analysis/statistics.ts:54` | `statistics.test.ts` |
| `exprToLatex` | `src/analysis/expression.ts:172` | `expression-gen.test.ts` |
| `toNandOnly` / `toNorOnly` / `limitFanIn` / `isNandOnly` / `isNorOnly` | `src/analysis/expression-modifiers.ts` | `expression-modifiers.test.ts` |
| `exportCsv` / `importCsv` / `exportHex` / `exportLatex` / `exportTestCase` / `loadTru` / `saveTru` | `src/analysis/truth-table-io.ts` | `truth-table-io.test.ts` |
| `grayCodeSequence` / `grayCodeIndex` / `cycleValue` / `KMapRenderContext` | `src/analysis/karnaugh-map.ts` | `karnaugh-map.test.ts` |

#### Solver — Digital

| Symbol | File | Test consumer(s) |
|--------|------|-------------------|
| `quickRun` / `speedTest` | `src/solver/digital/quick-run.ts` | `quick-run.test.ts` |
| `shuffleArray` | `src/solver/digital/noise-mode.ts:27` | `noise-mode.test.ts` |
| `MicroStepController` | `src/solver/digital/micro-step.ts:52` | `micro-step.test.ts` |
| `resolveDelays` | `src/solver/digital/delay.ts:32` | `delay.test.ts` |
| `canUseWorkerEngine` / `createEngine` | `src/solver/digital/worker-detection.ts` | `worker-detection.test.ts` |
| `WorkerEngine` | `src/solver/digital/worker-engine.ts:92` | `worker-engine.test.ts` |

#### Solver — Analog

| Symbol | File | Test consumer(s) |
|--------|------|-------------------|
| `test-elements.ts` (entire file) | `src/solver/analog/test-elements.ts` | 15+ analog test files |
| `MonteCarloRunner` / `SeededRng` / `computeOutputStatistics` | `src/solver/analog/monte-carlo.ts` | `monte-carlo.test.ts` |
| `ParameterSweepRunner` / `generateSweepValues` | `src/solver/analog/parameter-sweep.ts` | `monte-carlo.test.ts` |
| `buildFrequencyArray` | `src/solver/analog/ac-analysis.ts:294` | `ac-analysis.test.ts` |

#### Editor

| Symbol | File | Test consumer(s) |
|--------|------|-------------------|
| `captureRuntimeToDefaults` / `restoreAllFuses` | `src/editor/runtime-to-defaults.ts` | `runtime-to-defaults.test.ts` |
| `autoNumberLabels` / `addLabelPrefix` / `removeLabelPrefix` / `renameTunnel` | `src/editor/label-tools.ts` | `label-tools.test.ts` |
| `findUnconnectedPowerPins` | `src/editor/auto-power.ts:166` | `auto-power.test.ts` |
| `distancePointToSegment` | `src/editor/hit-test.ts:172` | `hit-test.test.ts` |
| `isPointOnSegmentInterior` | `src/editor/wire-drawing.ts:31` | `wire-drawing.test.ts` |
| `FileHistory` | `src/editor/file-history.ts:25` | `file-history.test.ts` |
| `PowerOverlay` | `src/editor/power-overlay.ts:39` | `power-overlay.test.ts` |

#### Runtime / Integration

| Symbol | File | Test consumer(s) |
|--------|------|-------------------|
| `RecordingContext` | `src/runtime/waveform-renderer.ts:64` | `waveform-renderer.test.ts` |
| `MeasurementOrderPanel` | `src/runtime/measurement-order.ts:62` | `measurement-order.test.ts` |
| `SingleValueDialog` | `src/runtime/value-dialog.ts:31` | `value-dialog.test.ts` |
| `loadProgram` | `src/runtime/program-loader.ts:56` | `program-loader.test.ts` |
| `detectFormatFromExtension` / `detectFormatFromContent` / `parseCsv` / `parseLogisim` / `parseRawBinary` | `src/runtime/program-formats.ts` | `program-loader.test.ts` |
| `AnalogRateController` / `FrameTarget` / `FrameResult` / `AnalogRateConfig` | `src/integration/analog-rate-controller.ts` | `analog-rate-controller.test.ts` |

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
| F22 | Triage test-only exports (Section 4c) — surface in UI or mark `@internal` | Per triage decision | varies |

### Dependency order within waves

Wave 0: F4 before F5 (analog types must exist before compiler refactor). F1-F3, F6 are independent.

Wave 1: F9-F10 are independent type moves. F11 is independent. F12-F14 are independent of each other. F7-F8 are independent.

Wave 2: All independent.

---

## Estimated Total Impact

| Metric | Before | After (all waves) |
|--------|--------|--------------------|
| Duplicated stamp helper copies | 21 | 1 |
| Duplicated gate scaffolding LOC | ~750 | ~50 |
| Core → editor/solver upward imports | 4 | 0 |
| Circular dependency chains | 2 | 0 |
| Truly dead exports | 8 | 0 |
| Internal-only exports leaking | 11 | 0 |
| Functions over 500 lines | 4 | 0 |
| Net LOC reduction | — | ~-1,200 |
