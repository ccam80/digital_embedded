# Test Plan: Extracted app-init Modules

Generated after reading all ten extracted modules in `src/app/` and cross-referencing
the existing Vitest unit tests (`src/app/__tests__/`) and Playwright E2E suite (`e2e/gui/`).

---

## 1. Per-Module Unit Test Specs

### 1.1 `dialog-manager.ts` — `createModal`

**Public surface:** One pure function `createModal(opts)` → `ModalResult`.

**What can be unit-tested (no real DOM needed beyond JSDOM):**
- Returned `overlay`, `dialog`, `header`, `body` elements have the expected class names.
- `header` contains a title span with `opts.title` as text.
- `header` contains a close button with `×`.
- Clicking the close button removes the overlay from the document.
- Clicking the overlay itself (not the dialog) calls `close()`.
- Clicking inside the dialog does NOT close the overlay.
- `opts.onClose` callback is invoked when close fires.
- Custom `className` propagates correctly (`modal-dialog` is default).
- Custom `overlayClassName` is applied when supplied.

**Requires DOM mocking:** Yes — `document.createElement` is called internally. Vitest's
`happy-dom` environment covers this; no jsdom install needed.

**Better covered by E2E only:** None — the function is pure DOM construction with no
canvas or async work.

**Specific test cases (5):**

```
createModal — builds expected DOM structure
  overlay has class 'modal-dialog-overlay'
  dialog has class 'modal-dialog'
  header span textContent equals opts.title
  close button has textContent '×'
  body has class 'modal-dialog-body'

createModal — clicking close button removes overlay from document
  append overlay to document.body, click close → overlay.isConnected === false

createModal — clicking overlay backdrop closes modal
  pointerdown event with target === overlay → overlay removed

createModal — clicking inside dialog does NOT close modal
  pointerdown event with target === dialog → overlay still attached

createModal — onClose callback is called exactly once on close
  opts.onClose mock is called once; second call to close() does not fire again
```

---

### 1.2 `analysis-dialogs.ts` — `isJsTestScript` / `evalJsTestScript`

**Public surface:** Two exported pure functions. The main `initAnalysisDialogs` entry
point is DOM-heavy and is better tested by E2E.

**What can be unit-tested:**
- `isJsTestScript` correctly identifies JS scripts vs plain-format test data.
- `evalJsTestScript` produces correct plain-format output for simple cases.
- `evalJsTestScript` throws on missing `signals()` call.
- `evalJsTestScript` throws when `row()` is called before `signals()`.
- `evalJsTestScript` throws on wrong arity in `row()`.
- `evalJsTestScript` handles `X`, `C`, `Z` sentinel constants.
- `evalJsTestScript` handles loop-generated rows (JS iteration).

**Requires DOM mocking:** No — both functions are pure JS, no DOM access.

**Better covered by E2E only:** `initAnalysisDialogs` wiring (button click → dialog appears).

**Specific test cases (5):**

```
isJsTestScript — returns true when text contains signals( call
  'signals("A","B"); row(0,0);' → true

isJsTestScript — returns false for plain-format test data
  'A B\n0 1\n1 0' → false

evalJsTestScript — produces correct plain-format for 2-input truth table
  signals('A','B'); row(0,0); row(0,1);
  → 'A B\n0 0\n0 1'

evalJsTestScript — throws when signals() never called
  'row(0);' → Error 'Test script must call signals()'

evalJsTestScript — loop generates correct number of rows
  signals('A'); for(let i=0;i<4;i++) row(i&1);
  → 4 data rows in output
```

---

### 1.3 `viewer-controller.ts` — `resolveSignalName`

**Public surface:** One exported utility `resolveSignalName(labelSignalMap, addr)`.
`initViewerController` itself is DOM-coupled and belongs in E2E.

**What can be unit-tested:**
- Returns the label string when a matching entry exists in the map.
- Falls back to `"node<id>"` for unmatched analog addresses.
- Falls back to `"net<id>"` for unmatched digital addresses.
- Picks the correct match (domain-aware) when both analog and digital entries share a
  label name in the map.

**Requires DOM mocking:** No — pure function.

**Better covered by E2E only:** All of `initViewerController` (scope panel DOM creation,
viewer open/close buttons, context menu items).

**Specific test cases (4):**

```
resolveSignalName — returns label for matching analog address
  map: [['VCC', {domain:'analog',nodeId:3}]]
  addr: {domain:'analog',nodeId:3} → 'VCC'

resolveSignalName — falls back to 'node<id>' for unknown analog address
  empty map, addr: {domain:'analog',nodeId:7} → 'node7'

resolveSignalName — returns label for matching digital address
  map: [['CLK', {domain:'digital',netId:5,bitWidth:1}]]
  addr: {domain:'digital',netId:5,bitWidth:1} → 'CLK'

resolveSignalName — falls back to 'net<id>' for unknown digital address
  empty map, addr: {domain:'digital',netId:12,bitWidth:4} → 'net12'
```

---

### 1.4 `simulation-controller.ts` — `loadEngineSettings` / `saveEngineSettings`

**Public surface:** Both functions are exposed on the returned `SimulationController`
interface. They use `localStorage`.

**What can be unit-tested (with mocked localStorage):**
- `loadEngineSettings` returns the default object when localStorage is empty.
- `loadEngineSettings` parses a valid stored JSON correctly.
- `loadEngineSettings` ignores invalid JSON without throwing.
- `loadEngineSettings` applies defaults for missing individual fields.
- `saveEngineSettings` writes a valid JSON string under `SETTINGS_STORAGE_KEY`.
- Round-trip: save then load produces the same object.
- `currentScaleMode` defaults to `'linear'` when the stored value is unrecognized.

**Requires DOM mocking:** `localStorage` — available in happy-dom by default.
The full `initSimulationController` requires heavy AppContext mocking; test `loadEngineSettings`
and `saveEngineSettings` as standalone helpers extracted to be importable, or test via
a thin wrapper that only exercises the settings path.

**Better covered by E2E only:** `startSimulation`, `stopSimulation`, the RAF render loop,
toolbar button wiring.

**Specific test cases (5):**

```
loadEngineSettings — returns defaults when localStorage empty
  { snapshotBudgetMb:64, oscillationLimit:1000, currentSpeedScale:200, currentScaleMode:'linear' }

loadEngineSettings — reads saved values from localStorage
  pre-set key with overrideSettings → fields match stored values

loadEngineSettings — ignores corrupt JSON and returns defaults
  set key to 'not-json' → default object, no throw

loadEngineSettings — defaults missing field when partial object stored
  stored { snapshotBudgetMb:128 } → oscillationLimit defaults to 1000

saveEngineSettings / loadEngineSettings round-trip
  save arbitrary settings → load → identical object
```

**Note:** The settings functions are currently embedded inside `initSimulationController`.
To unit-test them without mocking the full AppContext, they should be extracted to a
standalone `engineSettings.ts` helper (low-effort refactor, high test value).

---

### 1.5 `render-pipeline.ts` — `sizeCanvasInContainer` / `populateDiagnosticOverlays` / `canvasToScreen`

**Public surface:** `sizeCanvasInContainer(cvs)` → boolean; `populateDiagnosticOverlays(diags, wireToNodeId)`;
`canvasToScreen(e)` → Point.

**What can be unit-tested:**

`sizeCanvasInContainer`:
- Returns `true` and updates `canvas.width/height` when dimensions change.
- Returns `false` when dimensions are already correct (no-op).
- Returns `false` when target dimensions are 0 × 0.

`populateDiagnosticOverlays`:
- Pushes one overlay entry per involved-node that has a wire position.
- Skips diagnostics with empty `involvedNodes`.
- Assigns severity `'error'` vs `'warning'` correctly.
- Builds correct reverse map when multiple wires share the same nodeId.

`canvasToScreen`:
- Subtracts the canvas bounding rect from the client event coordinates.

**Requires DOM mocking:** Yes — `canvas.getBoundingClientRect`, `canvas.clientWidth/Height`,
`window.devicePixelRatio`. These are available in happy-dom.

**Better covered by E2E only:** `scheduleRender` (requires `requestAnimationFrame`), the
full `renderFrame` function, resize observer wiring.

**Specific test cases (5):**

```
sizeCanvasInContainer — returns true when canvas was resized
  canvas.clientWidth=400, canvas.height=0 → returns true, canvas.width updated

sizeCanvasInContainer — returns false when dimensions unchanged
  set canvas.width/height to already-correct values → returns false

populateDiagnosticOverlays — adds overlay for each node that has a wire
  one diagnostic with involvedNodes:[3], wireToNodeId maps wire→3
  → state.diagnosticOverlays has one entry at wire.start coords

populateDiagnosticOverlays — skips diagnostic with no involvedNodes
  diagnostic.involvedNodes = [] → state.diagnosticOverlays unchanged

populateDiagnosticOverlays — severity propagates correctly
  warning diagnostic → overlay.severity === 'warning'
```

---

### 1.6 `app-context.ts` — Interface only

**Public surface:** TypeScript interface declaration only. No runnable code.

**Unit testing:** Not applicable — this file has no implementation to test.

**Coverage strategy:** The AppContext contract is verified indirectly through tests
of the modules that consume it (see integration tests below).

---

### 1.7 `keyboard-handler.ts` — `initKeyboardHandler`

**What can be unit-tested (with minimal mock ctx and deps):**
- Pressing `Escape` when placement is active calls `ctx.placement.cancel()`.
- Pressing `Escape` when wireDrawing is active calls `ctx.wireDrawing.cancel()`.
- Pressing `Escape` when neither placement nor wireDrawing is active calls `deps.navigateBack()`.
- Pressing `Space` when `ctx.isSimActive()` is false calls `deps.startSimulation()` (after compile).
- Pressing `Space` when `ctx.isSimActive()` is true calls `deps.stopSimulation()`.
- Pressing `r` when placement is active calls `ctx.placement.rotate()`.
- Pressing `Delete` with a non-empty selection pushes a delete command to `undoStack`.
- Pressing `Ctrl+A` calls `ctx.selection.selectAll(ctx.circuit)`.
- Pressing `F4` calls `deps.togglePresentation()` regardless of target element.
- Input field guard: pressing `r` when target is `INPUT` does NOT call `ctx.placement.rotate()`.
- Pressing `Ctrl+Z` calls `ctx.undoStack.undo()` and `deps.invalidateCompiled()`.

**Requires DOM mocking:** Yes — dispatches `KeyboardEvent` on `document`. Works in
happy-dom.

**Better covered by E2E only:** Ctrl+S triggering a file download, Ctrl+O opening the
file picker.

**Specific test cases (5):**

```
Escape cancels active placement
  placement.isActive() = true → after Escape, placement.cancel called once

Escape calls navigateBack when no mode is active
  placement.isActive() = false, wireDrawing.isActive() = false
  → deps.navigateBack called once

Space starts simulation when sim is not running
  isSimActive() = false, ensureCompiled() = true → deps.startSimulation called

Delete deletes selected elements and calls invalidateCompiled
  selection has 1 element → undoStack.push called, invalidateCompiled called

F4 toggles presentation mode (no input-field guard)
  target = INPUT element → togglePresentation still called
```

---

### 1.8 `file-io-controller.ts` — `applyLoadedCircuit` logic

**What can be unit-tested:**
- `applyLoadedCircuit` clears existing elements/wires before adding from the loaded circuit.
- It calls `ctx.invalidateCompiled()` after loading.
- `updateCircuitName` sets the input value to the circuit metadata name.
- `updateCircuitName` defaults to `'Untitled'` when metadata name is empty.
- `circuitBaseName` (internal, used for exports) strips non-filesystem characters.

**Requires DOM mocking:** `document.getElementById` for `#circuit-name`, `document.body`.

**Better covered by E2E only:** File open dialog (`fileInput.change`), folder management
(IndexedDB interaction), all export buttons (download trigger requires browser `URL.createObjectURL`).

**Specific test cases (3 unit, 2 E2E-only):**

Unit:
```
applyLoadedCircuit — clears old elements before adding new ones
  ctx with 2 existing elements, loaded has 1 element
  → after call, circuit.elements.length === 1

applyLoadedCircuit — calls ctx.invalidateCompiled
  mock ctx → invalidateCompiled spy called once

updateCircuitName — sets input to metadata.name
  circuit.metadata.name = 'My Circuit' → circuitNameInput.value === 'My Circuit'
```

E2E:
```
File > Open with a .dig file loads the circuit (covered by existing circuit-building.spec.ts)
File > New resets circuit name to 'Untitled' (covered by menu-actions.spec.ts)
```

---

### 1.9 `canvas-interaction.ts` — `removeDeadEndStubs` helper

**What can be unit-tested:**
- `removeDeadEndStubs` removes a zero-length wire.
- It does NOT remove a wire whose endpoint touches a component pin.
- It removes a wire stub whose endpoint is isolated (no pin, no other wire endpoint).
- It does NOT remove a single wire even if one endpoint is isolated (single-wire edge case).

**Requires DOM mocking:** No — pure circuit graph manipulation. The function is module-private
but testable if exported (recommend exporting it for testing).

**Better covered by E2E only:** All pointer event handling (pointerdown, pointermove, pointerup),
touch gestures, subcircuit navigation stack, property popup lifecycle.

**Specific test cases (4 unit — requires `removeDeadEndStubs` to be exported):**

```
removeDeadEndStubs — removes zero-length wire
  wire with start === end → removed from circuit.wires

removeDeadEndStubs — keeps wire endpoint that touches a component pin
  pin at (5,5), wire from (5,5) to (5,8) → wire remains

removeDeadEndStubs — removes isolated stub when multiple wires present
  two wires: one connecting to a junction, one dangling with no pin contact
  → dangling wire removed

removeDeadEndStubs — keeps sole wire even if endpoint is isolated
  single wire in circuit, no pins → wire remains (length 1 edge case)
```

---

### 1.10 `menu-toolbar.ts` — `MenuToolbarController`

**What can be unit-tested:**
- `isPresentationMode()` returns `false` before `togglePresentation()` is called.
- `isPresentationMode()` returns `true` after `togglePresentation()` is called.
- `exitPresentation()` sets presentation mode back to `false`.

**Requires DOM mocking:** The full `initMenuAndToolbar` queries many DOM IDs at
init time. Testing in isolation requires a stub document. The presentation mode
state is the only logic extractable without full DOM.

**Better covered by E2E only:** Insert menu population (`rebuildInsertMenu`), zoom display,
search bar, lock mode, color scheme dialog, settings dialog, context menu appearance.

**Specific test cases (3 — requires extracted `presentationMode` state or light wrapper):**

```
isPresentationMode — false before any toggle
  freshly initialized → isPresentationMode() === false

togglePresentation — enters presentation mode
  call togglePresentation() → isPresentationMode() === true

exitPresentation — leaves presentation mode
  toggle in, then exitPresentation() → isPresentationMode() === false
```

---

## 2. Integration Test Specs

These tests verify that modules interact correctly through `AppContext`. They require
a real (but minimal) `AppContext` or a stub that approximates the wiring done in
`app-init.ts`.

### 2.1 AppContext wiring — `ensureCompiled()` delegates to `compileAndBind()`

```
When compiledDirty === true
  ctx.ensureCompiled() calls compileAndBind() exactly once
  returns false if compileAndBind() returns false
  sets compiledDirty = false on success

When compiledDirty === false
  ctx.ensureCompiled() does NOT call compileAndBind()
  returns true immediately
```

### 2.2 `invalidateCompiled` → `disposeViewers` → `scheduleRender` chain

This chain crosses `SimulationController`, `ViewerController`, and `RenderPipeline`.

```
Calling simController.invalidateCompiled():
  1. Sets ctx.compiledDirty = true
  2. Calls callbacks.disposeViewers() (ViewerController.disposeViewers spy)
  3. Calls renderPipeline.scheduleRender() (scheduleRender spy)

These three effects must all occur in order, with no assertions between them
being allowed to fail.
```

### 2.3 Module init order — `applyLoadedCircuit` patch propagates through AppContext

`FileIOController.init` patches `ctx.applyLoadedCircuit` at init time. Other modules
that call `ctx.applyLoadedCircuit()` after init should reach the `FileIOController`
implementation.

```
Given an AppContext stub with a placeholder applyLoadedCircuit
When initFileIOController(ctx) is called
Then ctx.applyLoadedCircuit === the FileIOController implementation
```

### 2.4 `initSimulationController` callbacks — `rebuildViewersIfOpen` is called after successful compile

```
Given simController with a mocked rebuildViewersIfOpen callback
When compileAndBind() succeeds
Then callbacks.rebuildViewersIfOpen() is called once
When compileAndBind() fails (facade.compile throws)
Then callbacks.rebuildViewersIfOpen() is NOT called
```

### 2.5 `ViewerController.resolveWatchedSignalAddresses` updates stale addresses after recompile

```
Given a watched signal with an old netId
And a new labelSignalMap that maps the same name to a new netId
When resolveWatchedSignalAddresses(unified) is called
Then watchedSignals[0].addr.netId === new netId
```

---

## 3. E2E Regression Tests

### 3.1 Existing E2E coverage mapping

| E2E file | Modules implicitly covered |
|---|---|
| `app-loads.spec.ts` | All modules (app startup) |
| `simulation-controls.spec.ts` | `SimulationController` (btn-tb-step, btn-tb-run, btn-tb-stop), `RenderPipeline` |
| `menu-actions.spec.ts` | `MenuToolbarController` (menus, dark mode), `ViewerController` (viewer open/close) |
| `circuit-building.spec.ts` | `CanvasInteraction` (placement, wiring), `KeyboardHandler` |
| `workflow-tests.spec.ts` | `FileIOController` (new/open), `SimulationController`, `CanvasInteraction` |
| `analog-rc-circuit.spec.ts` | `SimulationController` (analog start/stop), `ViewerController` (scope panels) |
| `analog-ui-fixup.spec.ts` | `RenderPipeline` (diagnostic overlays), `SimulationController` (analog viz) |
| `digital-circuit-assembly.spec.ts` | `CanvasInteraction`, `KeyboardHandler` |
| `mixed-circuit-assembly.spec.ts` | `SimulationController`, `CanvasInteraction` |

### 3.2 Coverage gaps — new modules with no dedicated E2E tests

| Module | Gap |
|---|---|
| `dialog-manager.ts` | No test verifies that modal overlays appear, close on × click, or close on backdrop click |
| `analysis-dialogs.ts` | Analysis dialog flow (Analyse Circuit button → truth table renders) not covered |
| `keyboard-handler.ts` | No test exercises keyboard shortcuts end-to-end in the browser |
| `viewer-controller.ts` | Adding a signal to the viewer via context menu on a wire not tested |
| `file-io-controller.ts` | Save-As prompt, format toggle (dig/digj), folder open/browse flow not covered |

### 3.3 Proposed new E2E scenarios

**E2E-1: Keyboard shortcuts — placement and edit operations**
File: `e2e/gui/keyboard-shortcuts.spec.ts`

```
test('pressing i places an In component')
  page.keyboard.press('i')
  canvas receives ghost cursor — no crash, canvas still visible

test('pressing Escape cancels active placement')
  press 'i' then 'Escape'
  no placement ghost visible, no console error

test('Ctrl+Z undoes a placed component')
  place a component via palette click, then Ctrl+Z
  undo button becomes disabled (nothing left to undo)

test('Delete removes selected element')
  place a component, click it to select, press Delete
  undo button becomes enabled (a deletion was recorded)
```

**E2E-2: Analysis dialog — truth table renders for a combinational circuit**
File: `e2e/gui/analysis-dialog.spec.ts`

```
test('Analyse Circuit opens the analysis dialog')
  load a simple AND gate circuit (via postMessage digital-load-data)
  Analysis menu > Analyse Circuit
  dialog overlay appears, truth table tab is active

test('Analysis dialog closes on × button click')
  open analysis dialog, click × button
  overlay is removed from DOM

test('Expression Editor tab renders without crash')
  open analysis dialog, click Expression Editor tab
  parse input is visible, no console error
```

**E2E-3: Modal dialog — backdrop closes overlay**
File: can be added to `e2e/gui/workflow-tests.spec.ts`

```
test('circuit picker dialog closes when backdrop is clicked')
  trigger the circuit picker modal (e.g. via a programmatic createModal call
  evaluated in the browser context, or by opening folder then cancelling)
  click outside the dialog bounds → overlay not in DOM
```

**E2E-4: Viewer controller — add wire to scope panel via context menu**
File: `e2e/gui/viewer-signals.spec.ts`

```
test('right-clicking a wire during simulation offers Add to Viewer')
  load an RC circuit, start simulation
  right-click a wire on the canvas
  context menu contains 'Add ... to Viewer' item

test('clicking Add to Viewer opens viewer panel with scope canvas')
  click the Add to Viewer menu item
  viewer panel is open, a canvas element appears inside viewer-timing-container
```

**E2E-5: FileIOController — format toggle changes save file extension**
File: `e2e/gui/file-io.spec.ts`

```
test('File > Format > .digj sets checkmark on digj option')
  open File menu, click Format > .digj
  .digj menu item has checkmark, .dig item does not

test('File > New creates an empty Untitled circuit')
  place a component, then File > New
  circuit-name input reads 'Untitled', canvas is empty (no elements)
```

---

## 4. Priority Order

Write tests in this order — highest debug-value-per-effort first.

| Priority | Test | Rationale |
|---|---|---|
| 1 | `evalJsTestScript` unit tests | Pure function, zero mocking, catches regressions in the JS sandbox evaluator that is hard to exercise interactively. Tests can be written and passing in under 30 minutes. |
| 2 | `isJsTestScript` unit tests | Same file, same effort, completes the analysis-dialogs unit surface. |
| 3 | `resolveSignalName` unit tests | Pure function, zero mocking. The fallback logic (`node<id>` / `net<id>`) is the most likely source of subtle display bugs. |
| 4 | `createModal` unit tests | DOM construction is fully testable in happy-dom. Covers a shared utility used by 4+ dialog sites. A regression here breaks all modal dialogs simultaneously. |
| 5 | `loadEngineSettings` / `saveEngineSettings` unit tests | localStorage-only, no AppContext needed. Guards against silent defaults when stored data is partial or corrupt. Requires a small refactor to export the helpers from simulation-controller.ts. |
| 6 | E2E: keyboard shortcuts (`keyboard-shortcuts.spec.ts`) | Keyboard shortcuts are currently untested end-to-end despite being a primary interaction model. One Playwright spec covers KeyboardHandler, UndoRedoStack, and PlacementMode wiring in one pass. |
| 7 | E2E: analysis dialog (`analysis-dialog.spec.ts`) | The entire `initAnalysisDialogs` body is DOM-event-driven and unreachable by unit tests. A single E2E spec with 3 tests covers the critical path (open → truth table → close). |
| 8 | Integration: `invalidateCompiled` → `disposeViewers` → `scheduleRender` chain | The cross-module callback chain is the most likely place for wiring bugs introduced during extraction. A focused integration test with spies catches missing or double-calls. |
| 9 | `sizeCanvasInContainer` unit tests | Guards against GPU reallocation regressions (returning `true` when dimensions did not actually change). Requires only a stub canvas element. |
| 10 | E2E: viewer signals (`viewer-signals.spec.ts`) | ViewerController is complex and currently uncovered. The context-menu-driven add-to-viewer path exercises viewer + simulationController + renderPipeline integration. Requires an analog circuit to be loaded first. |

---

## 5. Test File Locations

All new unit tests should go in `src/app/__tests__/` following the existing naming
convention `<module-name>.test.ts`.

New E2E specs go in `e2e/gui/` following the `<feature>.spec.ts` convention.

```
src/app/__tests__/
  dialog-manager.test.ts          ← new (createModal)
  analysis-dialogs.test.ts        ← new (isJsTestScript, evalJsTestScript)
  viewer-controller.test.ts       ← new (resolveSignalName)
  simulation-controller.test.ts   ← new (loadEngineSettings, saveEngineSettings)
  render-pipeline.test.ts         ← new (sizeCanvasInContainer, populateDiagnosticOverlays)
  keyboard-handler.test.ts        ← new (initKeyboardHandler with mock ctx)
  url-params.test.ts              ← exists ✓
  test-bridge.test.ts             ← exists ✓

e2e/gui/
  keyboard-shortcuts.spec.ts      ← new
  analysis-dialog.spec.ts         ← new
  viewer-signals.spec.ts          ← new
  file-io.spec.ts                 ← new
  app-loads.spec.ts               ← exists ✓
  simulation-controls.spec.ts     ← exists ✓
  menu-actions.spec.ts            ← exists ✓
  circuit-building.spec.ts        ← exists ✓
  workflow-tests.spec.ts          ← exists (add backdrop-close test here)
```

---

## 6. Notes on Testability Gaps

Two functions are currently private to their modules and would need to be exported to
enable unit testing:

- `removeDeadEndStubs` in `canvas-interaction.ts` — recommend exporting from the module.
- `loadEngineSettings` / `saveEngineSettings` in `simulation-controller.ts` — recommend
  extracting to `src/app/engine-settings.ts` so they can be tested without constructing
  the full `SimulationController`.

These are small refactors that add test surface without changing behavior.
