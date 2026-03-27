# Embedded Tutorial Runner

## Problem

The simulator has a full tutorial authoring pipeline (manifests, presets, validation, MCP tools) and a postMessage protocol with tutorial messages, but no in-iframe runtime. Currently, driving a tutorial requires the parent page to orchestrate every step via individual postMessages. We need a self-contained runner inside the simulator that a parent page activates with a single message.

## Design

### Activation

Parent sends one message:

```
{ type: 'digital-load-tutorial', manifest: TutorialManifest }
```

The simulator responds with:

```
{ type: 'digital-tutorial-loaded', tutorialId: string, totalSteps: number }
```

Optional parent-driven navigation:

```
{ type: 'digital-tutorial-goto', stepIndex: number }
```

Step change / validation notifications back to parent:

```
{ type: 'digital-tutorial-step-changed', stepIndex: number, stepId: string, title: string }
{ type: 'digital-tutorial-check-result', stepIndex: number, passed: boolean, message: string }
```

### UI Layout (tutorial active)

```
+--------+-----------+-------------------------------+
|palette | tutorial  |                               |
|(200px) | shelf     |        canvas                 |
|collapse| (280px)   |                               |
| <->    | collapse  |                               |
|        | <->       |                               |
+--------+-----------+-------------------------------+
                     | < Prev | 2/5 | Check | Next > |
                     +-------------------------------+
```

- Palette is collapsible at all breakpoints (not just mobile) via a toggle on its right edge
- Tutorial shelf sits between palette and canvas, also collapsible via edge toggle
- Bottom bar is inside `#canvas-container`, at the bottom, spanning canvas width only
- Canvas area shrinks vertically to accommodate the bar (~36px)

### Mobile (<768px)

- Palette and shelf both collapse to zero width by default
- Bottom bar remains, full width
- Tap shelf toggle to slide shelf in as overlay

## New Files

### `src/app/tutorial/tutorial-runner.ts` -- Step state machine (no DOM)

```ts
interface TutorialCallbacks {
  setPalette(components: string[] | null): void;
  loadCircuitXml(xml: string): Promise<void> | void;
  loadEmptyCircuit(): void;
  getCircuitSnapshot(): string;               // base64 dig XML
  setReadonlyComponents(labels: string[] | null): void;
  highlight(labels: string[], durationMs: number): void;
  runTests(testData: string): Promise<TestResult>;
  compile(): { ok: boolean; error?: string };
  postToParent(msg: unknown): void;
}

interface TestResult { passed: number; failed: number; total: number; message?: string }
```

Class `TutorialRunner`:
- `constructor(manifest, callbacks)`
- `goToStep(index)` -- resolve palette spec, load start circuit (null/carry-forward/spec/path), apply locked components + highlights, notify callbacks
- `next()` / `prev()` -- navigation; `next()` gated on `stepProgress.completed` for guided steps
- `check()` -- dispatches by `step.validation`: test-vectors -> `callbacks.runTests()`, compile-only -> `callbacks.compile()`, manual -> mark complete, equivalence -> not supported in-iframe (falls back to test-vectors if testData present)
- `revealHint()` -- increment `hintsRevealed`, return hint content
- `currentStep`, `currentStepIndex`, `stepCount`, `progress` getters
- `dispose()` -- cleanup

Progress: `TutorialProgress` stored in `localStorage` keyed `tutorial-progress-${manifest.id}`. Loaded on construction, saved on step change / check pass.

Circuit snapshots captured on step change (for carry-forward).

### `src/app/tutorial/tutorial-bar.ts` -- Bottom navigation bar

Creates and manages `<div id="tutorial-bar">` appended to `#canvas-container`.

Structure:
```html
<div id="tutorial-bar">
  <button class="tutorial-bar-btn" data-action="prev" disabled>Prev</button>
  <span class="tutorial-bar-step">1 / 5</span>
  <span class="tutorial-bar-title">Build an SR Latch</span>
  <button class="tutorial-bar-btn tutorial-bar-check" data-action="check">Check</button>
  <button class="tutorial-bar-btn" data-action="next">Next</button>
</div>
```

- `update(step, index, total, progress)` -- refresh labels, button states
- `setCheckState(state: 'idle' | 'running' | 'pass' | 'fail')` -- visual feedback
- `onAction(callback: (action: 'prev' | 'next' | 'check') => void)` -- event binding
- `show()` / `hide()` / `dispose()`
- Check button text changes: "Check" | "Checking..." | "Pass!" | "Try again"
- For `validation: 'manual'`, check button reads "Mark complete"

### `src/app/tutorial/tutorial-shelf.ts` -- Instructions pull-out shelf

Creates `<div id="tutorial-shelf">` inserted into `#workspace` after palette-resize-handle, before canvas-container.

Structure:
```html
<div id="tutorial-shelf">
  <div class="tutorial-shelf-header">
    <span class="tutorial-shelf-title">Instructions</span>
    <button class="tutorial-shelf-collapse" title="Collapse">&lsaquo;</button>
  </div>
  <div class="tutorial-shelf-body">
    <!-- rendered markdown -->
  </div>
  <div class="tutorial-shelf-hints">
    <button class="tutorial-shelf-hint-btn">Show hint</button>
    <div class="tutorial-shelf-hint-content"></div>
  </div>
</div>
```

- `setContent(markdown, hints?, hintsRevealed?)` -- render instructions + hint buttons
- `revealHint(index, content)` -- append hint content
- `collapse()` / `expand()` / `toggle()`
- `show()` / `hide()` / `dispose()`
- Uses `renderMarkdown()` from `markdown-renderer.ts`

## Modified Files

### `src/io/postmessage-adapter.ts`

- Add `digital-load-tutorial` and `digital-tutorial-goto` to switch/dispatch
- Add `loadTutorial?(manifest: TutorialManifest): void` to `PostMessageHooks`
- Add `tutorialGoto?(stepIndex: number): void` to `PostMessageHooks`

### `src/app/app-init.ts`

Add `loadTutorial` hook implementation:
1. Create `TutorialRunner` with callbacks wired to existing app-context methods
2. Create `TutorialBar` targeting `#canvas-container`
3. Create `TutorialShelf` targeting `#workspace`
4. Wire bar actions -> runner methods
5. Wire runner step-change -> bar.update() + shelf.setContent()
6. Wire runner validation -> bar.setCheckState()

Reuses existing hook patterns: `setPalette`, `loadCircuitXml`, `setReadonlyComponents`, `highlight`.

### `simulator.html` (CSS only)

Add styles for:
- `#tutorial-bar` -- 36px height, flex row, centered items, bottom of canvas-container
- `#tutorial-shelf` -- 280px width, flex-shrink: 0, overflow-y auto, border-right
- `.tutorial-shelf-collapsed` -- width: 0, overflow: hidden
- `.tutorial-bar-btn` -- minimal button styling
- `.tutorial-bar-check.pass` / `.fail` -- green/red accent
- Palette collapse at all breakpoints: add a collapse toggle affordance to `#palette-panel`
- `#canvas-container.has-tutorial-bar` -- padding-bottom: 36px to make room
- Responsive (<768px): shelf as overlay

### Palette collapse (all breakpoints)

Currently the palette only collapses on mobile/tablet. Make it collapsible everywhere:
- Add a thin vertical toggle strip on the right edge of `#palette-panel` (or reuse the resize handle area)
- `#palette-panel.collapsed` -- `width: 0; overflow: hidden` with the toggle strip still visible
- Toggle strip shows `>` when collapsed, `<` when expanded
- Wire toggle in `menu-toolbar.ts` where existing palette toggle lives
- This is a general editor improvement, not tutorial-specific

## Implementation Order

1. Palette collapse (general improvement, touches simulator.html CSS + menu-toolbar.ts)
2. `tutorial-runner.ts` (pure logic, testable in isolation)
3. `tutorial-shelf.ts` (DOM, depends on markdown-renderer)
4. `tutorial-bar.ts` (DOM)
5. `simulator.html` CSS for shelf + bar
6. `postmessage-adapter.ts` new messages
7. `app-init.ts` wiring

## Verification

- `npm run build` passes
- `npm test` passes (no regressions)
- Manual: serve locally, open simulator.html in iframe, postMessage a 2-step manifest, verify step navigation + check + shelf + palette collapse all work
