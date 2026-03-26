# app-init.ts Modularization Plan

## Problem

`src/app/app-init.ts` is a 5215-line god-function. A single `initApp()` closure
captures ~90 locals, ~60 inner functions, 99 click listeners, and 7 hand-built
modal dialogs. This blocks unit testing, makes debugging costly, and creates
diffuse blame when things break.

## Target Architecture

Split into 10 modules around natural responsibility boundaries. Each module
exports an `init(ctx: AppContext)` function and receives only the shared state
it needs via a typed interface — no more ambient closure capture.

After extraction, `app-init.ts` becomes a ~150-line orchestrator.

```
app-init.ts (orchestrator)
  ├── AppContext           ← shared state struct (no deps)
  ├── RenderPipeline       ← AppContext
  ├── CanvasInteraction    ← AppContext, RenderPipeline
  ├── KeyboardHandler      ← AppContext
  ├── SimulationController ← AppContext, RenderPipeline
  ├── ViewerController     ← AppContext, SimulationController
  ├── FileIOController     ← AppContext
  ├── AnalysisDialogs      ← AppContext, DialogManager
  ├── MenuAndToolbar       ← AppContext, DialogManager, SimulationController
  └── DialogManager        ← standalone utility
```

## Duplication Inventory

| ID | Pattern | Count | Fix |
|----|---------|-------|-----|
| D1 | Modal dialog boilerplate (overlay+header+close+backdrop) | 7 | `DialogManager.createModal()` |
| D2 | Interactive component toggle (In/Clock + Switch) during sim | 2 blocks | `toggleInteractiveComponent()` |
| D3 | `compiledDirty && !compileAndBind()` guard | 6 | `ensureCompiled()` on AppContext |
| D4 | Diagnostic overlay population (error vs warning) | 2 blocks | Single loop, filter inline |
| D5 | Signal name resolution from labelSignalMap | 3 | `resolveSignalName()` |
| D6 | Wire completion try/catch | 4 | `tryCompleteWire()` |
| D7 | `fitToContent` with identical args | 4 | `fitViewport()` |
| D8 | Export error `.catch()` | 4 | `downloadExport()` |
| D9 | Color scheme class toggling | 3 | Consolidate into one `applyColorScheme()` |

## Execution Steps

Each step is a single commit. Build must pass after each step.

### Step 1: DialogManager (utility, zero risk)
- Create `src/app/dialog-manager.ts`
- Export `createModal({ title, className?, onClose? })` → `{ overlay, dialog, body, footer, close() }`
- Export `createDialogHeader(title, onClose)` → `{ header, closeBtn }`
- Replaces D1 boilerplate in all 7 dialogs
- No changes to behavior

### Step 2: AppContext (shared state interface)
- Create `src/app/app-context.ts`
- Define `AppContext` interface with all shared state + helper methods
- `ensureCompiled()` (fixes D3), `fitViewport()` (fixes D7), `showStatus()`, `clearStatus()`
- `app-init.ts` creates the concrete object and passes it to modules
- No extraction yet — just define the interface and build the object

### Step 3: RenderPipeline
- Create `src/app/render-pipeline.ts`
- Extract: `resizeCanvas()`, `scheduleRender()`, `renderFrame()`, frame profiling,
  diagnostic overlay rendering, canvas sizing cache
- Export `initRenderPipeline(ctx) → { scheduleRender, resizeCanvas }`
- Fix D4 (merge error/warning diagnostic overlay population)

### Step 4: SimulationController
- Create `src/app/simulation-controller.ts`
- Extract: `startSimulation()`, `stopSimulation()`, `_startRenderLoop()`,
  analog viz activate/update/deactivate, speed control UI bindings,
  toolbar Step/Run/Stop/MicroStep/RunToBreak, `compileAndBind()`
- Fix D2 (deduplicate interactive component toggle)
- Fix D3 (use `ensureCompiled()`)

### Step 5: KeyboardHandler
- Create `src/app/keyboard-handler.ts`
- Merge all three `keydown` listeners into one
- Extract: edit shortcuts, placement shortcuts, Ctrl+S/O, F4 presentation, Escape routing

### Step 6: ViewerController
- Create `src/app/viewer-controller.ts`
- Extract: `WatchedSignal[]`, scope panels, `DataTablePanel`, `addWireToViewer()`,
  `removeSignalFromViewer()`, `rebuildViewers()`, `disposeViewers()`,
  scope context menus, viewer tab management
- Fix D5 (extract `resolveSignalName()`)

### Step 7: FileIOController
- Create `src/app/file-io-controller.ts`
- Extract: file open/save/save-as, folder open/browse/close/IndexedDB restore,
  circuit picker dialog, export (SVG/PNG/GIF/ZIP), format toggle, circuit name
- Fix D8 (shared `downloadExport()`)
- Uses DialogManager for circuit picker

### Step 8: AnalysisDialogs
- Create `src/app/analysis-dialogs.ts`
- Extract: `openAnalysisDialog()`, truth table, K-map, expressions,
  expression editor, critical path, state transition, test vector editor
- Uses DialogManager for all overlays
- Fix D9 partially (color scheme dialog moves to MenuAndToolbar)

### Step 9: CanvasInteraction
- Create `src/app/canvas-interaction.ts`
- Extract: all pointer event handlers, drag state machine, box-select,
  touch gesture delegation, long-press, coordinate helpers
- Fix D6 (extract `tryCompleteWire()`)
- Most coupled module — do last among content extractions

### Step 10: MenuAndToolbar + final cleanup
- Create `src/app/menu-toolbar.ts`
- Extract: insert menu, context menu builders, dark mode, zoom, lock, undo/redo
  toolbar, presentation mode, tablet mode, palette toggle/resize, panel resize,
  color scheme dialog, settings dialog
- Fix D9 (consolidate `applyColorScheme()`)
- `app-init.ts` becomes the ~150-line orchestrator

## Constraints

- Build (`npm run build`) must pass after every step
- No behavioral changes — pure mechanical extraction
- Each module is independently testable via its `init(ctx)` entry point
- No new dependencies added
- Existing tests must continue passing
