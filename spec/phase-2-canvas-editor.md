# Phase 2: Canvas Editor

**Depends on**: Phase 1 (complete)
**Parallel with**: Phases 3, 4, 5
**Blocks**: Phase 6 (Core Integration)

## Overview

The complete interactive circuit editor and the headless SimulatorFacade API. Wave 2.0 defines the programmatic facade that LLMs and the postMessage bridge use to build and simulate circuits. Waves 2.1–2.5 build the browser-based canvas editor with Digital's UI layout: tree palette on the left, collapsible property panel on the right, toolbar on top, canvas in the center. All panels are collapsible for iframe-embedded mode. Display components (Terminal, LED Matrix, VGA) render into separate floating panels.

## Binding Decisions

All decisions from `spec/shared-decisions.md` apply. Additionally:

- **Facade returns direct objects, not opaque handles.** `createCircuit()` returns `Circuit`, `compile()` returns `SimulationEngine`. The postMessage adapter (Phase 9, task 9.3.2) maps these to numeric IDs for the wire protocol. TypeScript callers get full type safety.
- **Facade is composed from modules.** The facade interface is defined once. Implementation is split into builder (Phase 2), runner (Phase 3), loader (Phase 4), and tester (Phase 6). Each module is independently testable.
- **Browser-dep fence uses built-in ESLint rules.** `no-restricted-imports` blocks `src/editor/` from headless/core/engine/io/testing. `no-restricted-globals` blocks DOM globals in those directories.
- **UI layout clones Digital.** Tree-based component palette (left), collapsible property panel (right), toolbar (top), canvas (center). All panels collapsible for iframe embedding — full functionality preserved, but chrome can be hidden. Display components get separate floating panels.

---

## Wave 2.0: Headless Simulator Facade

### Task 2.0.1 — SimulatorFacade Interface

- **Description**: Define the headless API contract — the single programmatic surface for LLMs, AI agents, and the postMessage bridge. This is a *definition-only* task: the interface and types. The primary use case is LLMs designing and simulating circuits, so method names must be clear, error messages must be plain English (not stack traces), and return types must have good `toString()` representations.

- **Files to create**:
  - `src/headless/facade.ts` — `SimulatorFacade` interface with all method signatures. Methods grouped by lifecycle stage:
    - **Building**: `createCircuit(opts?)`, `addComponent(circuit, typeName, props?)`, `connect(circuit, srcComponent, srcPin, dstComponent, dstPin)`
    - **Compilation**: `compile(circuit)` — returns `SimulationEngine`
    - **Simulation**: `step(engine)`, `run(engine, cycles)`, `runToStable(engine, maxIterations?)`, `setInput(engine, label, value)`, `readOutput(engine, label)`, `readAllSignals(engine)`
    - **Testing**: `runTests(engine, circuit)` — returns `TestResults`
    - **File I/O**: `loadDig(pathOrXml)`, `serialize(circuit)`, `deserialize(json)`
  - `src/headless/types.ts` — `TestResults` type (`{ passed, failed, total, vectors[] }`), `FacadeError` class (wraps all facade errors with plain English messages and structured context), `CircuitBuildOptions` type

- **Files to modify**: (none)

- **Tests**:
  - `src/headless/__tests__/facade-types.test.ts::FacadeTypes::testResultsShape` — assert `TestResults` has `passed`, `failed`, `total` as numbers and `vectors` as array
  - `src/headless/__tests__/facade-types.test.ts::FacadeTypes::facadeErrorCarriesContext` — assert `FacadeError` carries `componentName`, `pinLabel`, or `circuitName` context fields and produces a readable `.message`

- **Acceptance criteria**:
  - `SimulatorFacade` interface is importable from `src/headless/facade.ts`
  - All method signatures reference only types from `src/core/` and `src/headless/types.ts` — no browser types
  - `FacadeError` message reads as plain English (e.g., "Unknown component type 'Andd'. Did you mean 'And'?" — not a raw stack trace)
  - All types pass `tsc --noEmit`

---

### Task 2.0.2 — Circuit Builder Implementation

- **Description**: Implement the building portion of the facade: `createCircuit`, `addComponent`, `connect`. `addComponent` looks up `ComponentDefinition` in a `ComponentRegistry`, calls `factory(props)`, auto-assigns a grid-snapped position (sequential placement by insertion order, or caller-specified via optional `position` in props), adds to `Circuit`, returns the `CircuitElement`. `connect` resolves pin labels on source/destination components to `Pin` instances, creates `Wire` segments between pin world-space positions. Validates with clear `FacadeError` messages: unknown component type (suggest closest match), unknown pin label (list valid pins), bit-width mismatch. Zero browser dependencies — pure Node.js compatible.

- **Files to create**:
  - `src/headless/builder.ts` — `CircuitBuilder` class:
    - `constructor(registry: ComponentRegistry)`
    - `createCircuit(opts?: CircuitBuildOptions): Circuit`
    - `addComponent(circuit: Circuit, typeName: string, props?: Record<string, PropertyValue>): CircuitElement` — looks up definition, merges caller props over defaults, calls factory, auto-positions, adds to circuit
    - `connect(circuit: Circuit, src: CircuitElement, srcPinLabel: string, dst: CircuitElement, dstPinLabel: string): Wire` — resolves pins by label, validates direction (output→input or bidirectional), validates bit width match, creates Wire, adds to circuit
    - Auto-position logic: elements placed on a grid at (0, n*4) by insertion order unless the caller specifies `position` in the props map

- **Files to modify**: (none)

- **Tests**:
  - `src/headless/__tests__/builder.test.ts::CircuitBuilder::createsEmptyCircuit` — assert `createCircuit()` returns a `Circuit` with zero elements and zero wires
  - `src/headless/__tests__/builder.test.ts::CircuitBuilder::addsComponentByTypeName` — register a mock component, call `addComponent(circuit, "Mock")`, assert circuit has 1 element with correct typeId
  - `src/headless/__tests__/builder.test.ts::CircuitBuilder::mergesCallerProps` — register mock with default `bitWidth: 1`, call `addComponent` with `{ bitWidth: 8 }`, assert element properties have `bitWidth === 8`
  - `src/headless/__tests__/builder.test.ts::CircuitBuilder::autoPositionsSequentially` — add 3 components, assert positions are (0,0), (0,4), (0,8)
  - `src/headless/__tests__/builder.test.ts::CircuitBuilder::connectsOutputToInput` — add two mock components, connect output pin to input pin, assert circuit has 1 wire with correct start/end points
  - `src/headless/__tests__/builder.test.ts::CircuitBuilder::rejectsUnknownType` — call `addComponent(circuit, "Andd")`, assert throws `FacadeError` with message containing "Unknown component type" and suggestion "And"
  - `src/headless/__tests__/builder.test.ts::CircuitBuilder::rejectsUnknownPin` — call `connect` with bad pin label, assert throws `FacadeError` listing valid pin labels
  - `src/headless/__tests__/builder.test.ts::CircuitBuilder::rejectsBitWidthMismatch` — connect 1-bit output to 8-bit input, assert throws `BitsException`
  - `src/headless/__tests__/builder.test.ts::CircuitBuilder::rejectsInputToInput` — connect two input pins, assert throws `FacadeError`

- **Acceptance criteria**:
  - Half-adder can be built programmatically: `addComponent` for `In` x2, `And`, `XOr`, `Out` x2, then `connect` all pins — resulting `Circuit` has 6 elements and correct wire topology
  - All error messages are plain English with component/pin context
  - Zero browser dependencies — runs in Node.js with no DOM polyfills
  - All tests pass

---

### Task 2.0.3 — Headless Entry Point and Browser-Dep Fence

- **Description**: Create the headless barrel export and add ESLint rules preventing browser dependencies in headless/core/engine/io/testing code.

- **Files to create**:
  - `src/headless/index.ts` — barrel re-export of facade interface, builder, types, and all core types (`BitVector`, `Circuit`, `Net`, `Wire`, `Pin`, `PropertyBag`, `ComponentRegistry`, `SimulationEngine`, error types)

- **Files to modify**:
  - `eslint.config.js` — add override blocks:
    - For files in `src/headless/**`, `src/core/**`, `src/engine/**`, `src/io/**`, `src/testing/**`: enable `no-restricted-imports` blocking any import path containing `src/editor/`
    - For the same files: enable `no-restricted-globals` blocking `window`, `document`, `HTMLCanvasElement`, `CanvasRenderingContext2D`, `HTMLElement`, `Element`, `navigator`, `localStorage`, `sessionStorage`, `requestAnimationFrame`, `cancelAnimationFrame`

- **Tests**:
  - `src/headless/__tests__/fence.test.ts::BrowserDepFence::headlessBarrelImportable` — dynamically import `src/headless/index.ts`, assert all expected exports exist (`CircuitBuilder`, `BitVector`, `Circuit`, `Wire`, `Pin`, etc.)
  - The ESLint fence is verified by CI: add a test file `src/headless/__tests__/fence-violation.lint.ts` that intentionally imports from `src/editor/` and references `document` — run `npm run lint` and assert it produces errors. (This file has a `.lint.ts` extension and is excluded from `tsc` but included in ESLint.)

- **Acceptance criteria**:
  - `import { CircuitBuilder, BitVector, Circuit } from '../headless'` works from any file
  - `npm run lint` fails if any file in the fenced directories imports from `src/editor/` or uses DOM globals
  - `npm run typecheck` still passes (the lint-only test file is excluded from tsc)

---

### Task 2.0.4 — Builder Smoke Tests

- **Description**: Integration-level tests exercising the circuit builder with mock component definitions, verifying the full build flow in Node.js.

- **Files to create**:
  - `src/headless/__tests__/builder-integration.test.ts` — tests using a real `ComponentRegistry` populated with mock component definitions (simple mock elements that implement `CircuitElement`):
    - `halfAdderTopology` — programmatically build a half-adder (2 In, 1 And, 1 XOr, 2 Out), connect all pins, verify circuit model: 6 elements, 6 wires, correct pin connections by tracing wire start/end positions to pin positions
    - `duplicateConnection` — connect the same output to the same input twice, assert throws `FacadeError` (no duplicate wires)
    - `callerSpecifiedPosition` — add component with explicit position `{ x: 10, y: 20 }` in props, assert element position matches
    - `circuitMetadata` — create circuit with `{ name: "Test" }`, assert metadata preserved

- **Acceptance criteria**:
  - All tests run in Node.js (Vitest), no browser
  - Half-adder circuit model is structurally correct
  - All tests pass

---

## Wave 2.1: Canvas Foundation

### Task 2.1.1 — Canvas 2D Renderer

- **Description**: Implement the `RenderContext` interface from Phase 1 using the browser Canvas 2D API. All drawing primitives map to `CanvasRenderingContext2D` calls. The renderer holds a `ColorScheme` reference and resolves `ThemeColor` → CSS string on every `setColor()` call. Theme switching via `setColorScheme(scheme)`.

- **Files to create**:
  - `src/editor/canvas-renderer.ts` — `CanvasRenderer` class implementing `RenderContext`:
    - `constructor(ctx: CanvasRenderingContext2D, scheme: ColorScheme)`
    - `setColorScheme(scheme: ColorScheme)` — swap theme at runtime
    - All `RenderContext` methods delegating to `CanvasRenderingContext2D`
    - Transform stack: `save()`/`restore()` delegate to `ctx.save()`/`ctx.restore()`
    - `drawText` handles `TextAnchor` via `ctx.textAlign` and `ctx.textBaseline` mapping
    - `drawPath` iterates `PathData.operations` and maps to `ctx.moveTo`/`ctx.lineTo`/`ctx.bezierCurveTo`/`ctx.closePath`
    - `setLineDash` delegates to `ctx.setLineDash()`

- **Tests**:
  - `src/editor/__tests__/canvas-renderer.test.ts::CanvasRenderer::delegatesDrawLine` — create renderer with a mock `CanvasRenderingContext2D` (jest-canvas-mock or manual stub), call `drawLine(0,0,10,10)`, assert `ctx.beginPath`, `ctx.moveTo(0,0)`, `ctx.lineTo(10,10)`, `ctx.stroke` were called
  - `src/editor/__tests__/canvas-renderer.test.ts::CanvasRenderer::resolvesThemeColors` — call `setColor("WIRE_HIGH")`, assert `ctx.strokeStyle` is set to the default scheme's WIRE_HIGH value
  - `src/editor/__tests__/canvas-renderer.test.ts::CanvasRenderer::switchesColorScheme` — set high-contrast scheme, call `setColor("BACKGROUND")`, assert it resolves to `#000000`
  - `src/editor/__tests__/canvas-renderer.test.ts::CanvasRenderer::transformStack` — call `save`, `translate(5,5)`, `restore`, assert `ctx.save`, `ctx.translate(5,5)`, `ctx.restore` were called in order

- **Acceptance criteria**:
  - `CanvasRenderer` implements every method of `RenderContext`
  - Color resolution goes through `ColorScheme`, never hardcoded
  - All tests pass

---

### Task 2.1.2 — Coordinate System and Grid

- **Description**: World ↔ screen coordinate transforms, grid rendering, grid snapping. Digital uses 20px grid spacing at 1x zoom. Grid has major lines (every 5 grid units) and minor lines (every 1 grid unit). Snap-to-grid is on by default with a toggle.

- **Files to create**:
  - `src/editor/coordinates.ts` — pure functions:
    - `worldToScreen(world: Point, zoom: number, pan: Point): Point`
    - `screenToWorld(screen: Point, zoom: number, pan: Point): Point`
    - `snapToGrid(world: Point, gridSize: number): Point`
    - `GRID_SPACING = 20` (pixels per grid unit at 1x zoom)
  - `src/editor/grid.ts` — `GridRenderer`:
    - `render(ctx: RenderContext, viewport: Rect, zoom: number, pan: Point)` — draws minor grid lines (ThemeColor `GRID`), major grid lines (slightly darker, via a second ThemeColor or thicker line width), respects zoom level (hide minor lines when zoomed out far)

- **Tests**:
  - `src/editor/__tests__/coordinates.test.ts::Coordinates::worldToScreenIdentity` — at zoom=1, pan=(0,0): world (5,5) → screen (100,100) (5 * 20px)
  - `src/editor/__tests__/coordinates.test.ts::Coordinates::worldToScreenWithZoom` — at zoom=2, pan=(0,0): world (5,5) → screen (200,200)
  - `src/editor/__tests__/coordinates.test.ts::Coordinates::worldToScreenWithPan` — at zoom=1, pan=(10,10): world (0,0) → screen (10,10)
  - `src/editor/__tests__/coordinates.test.ts::Coordinates::screenToWorldRoundTrip` — arbitrary point round-trips through both transforms
  - `src/editor/__tests__/coordinates.test.ts::Coordinates::snapToGrid` — (2.3, 4.7) snaps to (2, 5) with gridSize=1
  - `src/editor/__tests__/grid.test.ts::GridRenderer::drawsGridLines` — render with MockRenderContext, assert `drawLine` calls were made for grid lines within the viewport

- **Acceptance criteria**:
  - Coordinate transforms are invertible (round-trip)
  - Grid renders only within the visible viewport (no off-screen draws)
  - Snap-to-grid rounds to nearest integer grid position
  - All tests pass

---

### Task 2.1.3 — Pan and Zoom

- **Description**: Mouse wheel zoom (centered on cursor position), middle-click drag or space+drag for panning, zoom limits (0.1x–10x), viewport management, fit-to-circuit, zoom presets.

- **Files to create**:
  - `src/editor/viewport.ts` — `Viewport` class:
    - State: `zoom: number`, `pan: Point` (world offset)
    - `zoomAt(screenPoint: Point, delta: number)` — zoom centered on cursor. Adjusts pan so the world point under the cursor stays fixed.
    - `panBy(screenDelta: Point)` — translate pan offset
    - `fitToContent(elements: CircuitElement[], canvasSize: { width: number; height: number })` — compute bounding box of all elements, set zoom and pan to fit with margin
    - `setZoom(level: number)` — clamp to [0.1, 10.0]
    - `getVisibleWorldRect(canvasSize): Rect` — world-space rectangle currently visible
    - Zoom presets: 0.5, 1.0, 1.5, 2.0, 3.0 (callable via `setZoom`)

- **Tests**:
  - `src/editor/__tests__/viewport.test.ts::Viewport::zoomAtCursorKeepsWorldPointFixed` — zoom in at screen center, verify the world point under cursor didn't move
  - `src/editor/__tests__/viewport.test.ts::Viewport::zoomClampsToLimits` — zoom below 0.1 clamps to 0.1, above 10 clamps to 10
  - `src/editor/__tests__/viewport.test.ts::Viewport::panByTranslatesOffset` — panBy(100,50), verify pan offset changed
  - `src/editor/__tests__/viewport.test.ts::Viewport::fitToContentCentersElements` — place elements at known positions, fitToContent, verify all elements are within the visible world rect
  - `src/editor/__tests__/viewport.test.ts::Viewport::getVisibleWorldRect` — at zoom=1, pan=(0,0), canvas 800x600: visible rect is (0, 0, 40, 30) in grid units

- **Acceptance criteria**:
  - Zoom centered on cursor: world point under cursor is invariant
  - Zoom limits enforced
  - Fit-to-circuit shows all elements with margin
  - All tests pass

---

## Wave 2.2: Element and Wire Rendering

### Task 2.2.1 — Component Rendering Dispatch

- **Description**: The render loop that iterates circuit elements and draws them. For each element: apply position/rotation/mirror transforms, call `element.draw(ctx)`, draw pin indicators (small circles at pin positions, colored by `ThemeColor.PIN`), draw negation bubbles and clock triangles based on pin flags, draw selection highlight (ThemeColor `SELECTION` outline) for selected elements.

- **Files to create**:
  - `src/editor/element-renderer.ts` — `ElementRenderer`:
    - `render(ctx: RenderContext, circuit: Circuit, selection: ReadonlySet<CircuitElement>, viewport: Rect)` — cull elements outside viewport, for each visible element: `ctx.save()`, translate to element position, apply rotation/mirror, call `element.draw(ctx)`, draw pins, draw selection if selected, `ctx.restore()`
    - `renderPins(ctx: RenderContext, element: CircuitElement)` — for each pin: draw filled circle (radius ~2px) at pin position; if `isNegated`, draw unfilled circle (negation bubble); if `isClock`, draw small triangle

- **Tests**:
  - `src/editor/__tests__/element-renderer.test.ts::ElementRenderer::drawsElementWithTransform` — render a mock element at position (5,3) with rotation=1, verify MockRenderContext received `save`, `translate(5,3)`, `rotate(Math.PI/2)`, then the element's draw calls, then `restore`
  - `src/editor/__tests__/element-renderer.test.ts::ElementRenderer::drawsPinIndicators` — render element with 2 pins, verify small circles drawn at pin positions
  - `src/editor/__tests__/element-renderer.test.ts::ElementRenderer::drawsNegationBubble` — element with negated pin, verify an unfilled circle at the pin position
  - `src/editor/__tests__/element-renderer.test.ts::ElementRenderer::drawsSelectionHighlight` — pass element in selection set, verify `setColor("SELECTION")` called and bounding box outline drawn
  - `src/editor/__tests__/element-renderer.test.ts::ElementRenderer::cullsOffscreenElements` — element outside viewport, verify no draw calls

- **Acceptance criteria**:
  - Elements drawn with correct position/rotation/mirror transforms
  - Pins, negation bubbles, clock markers all render
  - Selected elements get a visible highlight
  - Off-screen elements are culled (no draw calls)
  - All tests pass

---

### Task 2.2.2 — Wire Rendering

- **Description**: Render wire segments with Manhattan routing visuals. Junction dots at wire joins (port Digital's `DotCreator` — detect where 3+ wire endpoints meet at the same point and place a filled circle). Bus wires (multi-bit, `bitWidth > 1`) drawn thicker. Wire color by signal state (reads from engine via a signal-access callback, defaulting to `ThemeColor.WIRE` when no engine is connected). Bus value annotations (hex/dec labels on bus wires when simulation is running). Wire tooltips on hover (show current value — implementation deferred to the interaction layer, but the renderer exposes the data). Selection highlighting for selected wires.

- **Files to create**:
  - `src/editor/wire-renderer.ts` — `WireRenderer`:
    - `render(ctx: RenderContext, wires: readonly Wire[], selection: ReadonlySet<Wire>, signalAccess?: WireSignalAccess)` — for each wire: determine color from signal state (or default), set line width (1px for single-bit, 3px for bus), draw line segment, draw selection highlight if selected
    - `renderJunctionDots(ctx: RenderContext, wires: readonly Wire[])` — find all points where 3+ wire endpoints coincide, draw filled circle (radius ~3px)
    - `renderBusAnnotations(ctx: RenderContext, wires: readonly Wire[], signalAccess: WireSignalAccess)` — for bus wires with active signals, draw value label at wire midpoint
  - `src/editor/wire-signal-access.ts` — `WireSignalAccess` interface:
    - `getWireValue(wire: Wire): { raw: number; width: number } | undefined` — returns signal value for a wire, or undefined if no engine is connected. This is the bridge between the renderer and the engine binding layer (Phase 6).

- **Tests**:
  - `src/editor/__tests__/wire-renderer.test.ts::WireRenderer::drawsWireSegment` — render single wire, verify `drawLine` called with correct coordinates
  - `src/editor/__tests__/wire-renderer.test.ts::WireRenderer::busWireIsThicker` — wire with width > 1 via signal access, verify `setLineWidth(3)` called
  - `src/editor/__tests__/wire-renderer.test.ts::WireRenderer::junctionDotAtThreeWayJoin` — 3 wires meeting at same point, verify filled circle drawn at junction
  - `src/editor/__tests__/wire-renderer.test.ts::WireRenderer::noJunctionDotAtTwoWayJoin` — 2 wires meeting, verify no junction dot (pass-through)
  - `src/editor/__tests__/wire-renderer.test.ts::WireRenderer::wireColorBySignalState` — provide mock signal access returning high value, verify `setColor("WIRE_HIGH")` called
  - `src/editor/__tests__/wire-renderer.test.ts::WireRenderer::defaultColorWhenNoEngine` — no signal access provided, verify `setColor("WIRE")` used
  - `src/editor/__tests__/wire-renderer.test.ts::WireRenderer::selectedWireHighlighted` — wire in selection set, verify selection color applied

- **Acceptance criteria**:
  - Wires render as line segments between start and end points
  - Junction dots appear only at 3+ wire meets
  - Bus wires visually distinct from single-bit wires
  - Wire color reflects signal state when engine is connected
  - All tests pass

---

## Wave 2.3: Interaction Model

### Task 2.3.1 — Hit-Testing

- **Description**: Determine what the user clicked on. Point-in-element (bounding box check), point-near-wire (distance from point to line segment, threshold ~5 screen pixels), point-on-pin (within pin circle radius), priority ordering (pin > element > wire — pins are clickable even when overlapping their parent element), rectangular region intersection for box-select.

- **Files to create**:
  - `src/editor/hit-test.ts` — pure functions:
    - `hitTestElements(point: Point, elements: readonly CircuitElement[]): CircuitElement | undefined` — first element whose bounding box contains the point (front-to-back order, last added = on top)
    - `hitTestWires(point: Point, wires: readonly Wire[], threshold: number): Wire | undefined` — first wire within threshold distance
    - `hitTestPins(point: Point, elements: readonly CircuitElement[], threshold: number): { element: CircuitElement; pin: Pin } | undefined` — first pin within threshold distance
    - `hitTestAll(point: Point, circuit: Circuit, threshold: number): HitResult` — returns `{ type: 'pin', element, pin } | { type: 'element', element } | { type: 'wire', wire } | { type: 'none' }` with priority ordering pin > element > wire
    - `elementsInRect(rect: Rect, elements: readonly CircuitElement[]): CircuitElement[]` — all elements whose bounding box intersects the rect
    - `wiresInRect(rect: Rect, wires: readonly Wire[]): Wire[]` — all wires with at least one endpoint in the rect
    - Helper: `distancePointToSegment(point: Point, start: Point, end: Point): number`

- **Tests**:
  - `src/editor/__tests__/hit-test.test.ts::HitTest::hitsElementInBoundingBox` — point inside element BB returns that element
  - `src/editor/__tests__/hit-test.test.ts::HitTest::missesOutsideBoundingBox` — point outside all BBs returns undefined
  - `src/editor/__tests__/hit-test.test.ts::HitTest::hitsWireWithinThreshold` — point 3px from wire, threshold 5px, returns wire
  - `src/editor/__tests__/hit-test.test.ts::HitTest::missesWireBeyondThreshold` — point 10px from wire, threshold 5px, returns undefined
  - `src/editor/__tests__/hit-test.test.ts::HitTest::pinTakesPriorityOverElement` — point on a pin that's inside an element BB, returns pin hit
  - `src/editor/__tests__/hit-test.test.ts::HitTest::elementsInRectFindsOverlapping` — 3 elements, rect overlaps 2, returns those 2
  - `src/editor/__tests__/hit-test.test.ts::HitTest::distancePointToSegmentMidpoint` — point perpendicular to segment midpoint, verify correct distance
  - `src/editor/__tests__/hit-test.test.ts::HitTest::distancePointToSegmentEndpoint` — point beyond segment end, distance is to nearest endpoint

- **Acceptance criteria**:
  - Priority ordering: pin > element > wire > none
  - Distance-based wire hit test is geometrically correct
  - Box-select finds all intersecting elements and wires
  - All tests pass

---

### Task 2.3.2 — Selection Model

- **Description**: Track which elements and wires are selected. Click to select one (deselect all others). Shift+click to toggle selection. Box-select (click+drag on empty space creates selection rectangle). Ctrl+A selects all. Escape deselects all. The selection is a reactive Set that the renderer reads for highlighting.

- **Files to create**:
  - `src/editor/selection.ts` — `SelectionModel`:
    - State: `selectedElements: Set<CircuitElement>`, `selectedWires: Set<Wire>`
    - `select(item: CircuitElement | Wire)` — clear all, add item
    - `toggleSelect(item: CircuitElement | Wire)` — add if not present, remove if present
    - `boxSelect(elements: CircuitElement[], wires: Wire[])` — replace selection with these items
    - `selectAll(circuit: Circuit)` — select everything
    - `clear()` — deselect all
    - `isSelected(item: CircuitElement | Wire): boolean`
    - `isEmpty(): boolean`
    - `getSelectedElements(): ReadonlySet<CircuitElement>`
    - `getSelectedWires(): ReadonlySet<Wire>`
    - Change listener support: `onChange(callback)` for triggering re-renders

- **Tests**:
  - `src/editor/__tests__/selection.test.ts::SelectionModel::selectClearsPrevious` — select A, select B, assert only B selected
  - `src/editor/__tests__/selection.test.ts::SelectionModel::toggleAdds` — toggle A, assert A selected
  - `src/editor/__tests__/selection.test.ts::SelectionModel::toggleRemoves` — select A, toggle A, assert nothing selected
  - `src/editor/__tests__/selection.test.ts::SelectionModel::boxSelectReplacesAll` — select A, boxSelect [B, C], assert B and C selected, A not
  - `src/editor/__tests__/selection.test.ts::SelectionModel::selectAllGetsEverything` — 3 elements + 2 wires in circuit, selectAll, assert all 5 selected
  - `src/editor/__tests__/selection.test.ts::SelectionModel::clearDeselectsAll` — select items, clear, assert empty
  - `src/editor/__tests__/selection.test.ts::SelectionModel::onChangeFiresOnMutation` — register callback, select item, assert callback fired

- **Acceptance criteria**:
  - Single click selects one, deselects rest
  - Shift+click toggles without affecting rest
  - Box-select replaces entire selection
  - Change listeners fire on any mutation
  - All tests pass

---

### Task 2.3.3 — Placement Mode

- **Description**: When the user selects a component from the palette, enter placement mode. A ghost image of the component follows the cursor (grid-snapped). Click to place. R rotates 90° clockwise. M mirrors horizontally. Escape cancels placement mode. After placing, the mode can either remain active (for placing multiple copies) or return to select mode — match Digital's behavior (stays in placement mode, user presses Escape to exit).

- **Files to create**:
  - `src/editor/placement.ts` — `PlacementMode`:
    - `start(definition: ComponentDefinition)` — enter placement mode with a ghost element
    - `updateCursor(worldPoint: Point)` — move ghost to snapped position
    - `rotate()` — cycle ghost rotation 0→1→2→3→0
    - `mirror()` — toggle ghost mirror flag
    - `place(circuit: Circuit): CircuitElement` — instantiate real element at ghost position, add to circuit, return it (stays in placement mode for next copy)
    - `cancel()` — exit placement mode
    - `isActive(): boolean`
    - `getGhost(): { element: CircuitElement; position: Point; rotation: Rotation; mirror: boolean } | undefined` — for rendering the ghost overlay

- **Tests**:
  - `src/editor/__tests__/placement.test.ts::PlacementMode::ghostFollowsCursorSnapped` — start placement, updateCursor at (3.7, 2.3), ghost position is (4, 2)
  - `src/editor/__tests__/placement.test.ts::PlacementMode::rotatesCyclically` — rotate 4 times, verify rotation goes 0→1→2→3→0
  - `src/editor/__tests__/placement.test.ts::PlacementMode::mirrorToggles` — mirror twice returns to original
  - `src/editor/__tests__/placement.test.ts::PlacementMode::placeAddsToCircuit` — place, assert circuit has 1 new element at ghost position
  - `src/editor/__tests__/placement.test.ts::PlacementMode::staysActiveAfterPlace` — place, assert isActive() still true
  - `src/editor/__tests__/placement.test.ts::PlacementMode::cancelExitsMode` — cancel, assert isActive() is false

- **Acceptance criteria**:
  - Ghost snaps to grid
  - Rotation and mirror work on ghost before placing
  - Placed element appears in circuit with correct position/rotation/mirror
  - Mode persists after placing (Digital behavior)
  - Escape cancels
  - All tests pass

---

### Task 2.3.4 — Wire Drawing Mode

- **Description**: Click an output pin to start a wire, Manhattan-routed segments follow the cursor, click to place waypoints, click an input pin to complete the wire. Visual preview during drawing. Escape cancels. Wire consistency checking: validate the completed wire doesn't create illegal connections (two outputs on the same net without a bus). Wire merging: collinear adjacent segments are merged into a single segment.

- **Files to create**:
  - `src/editor/wire-drawing.ts` — `WireDrawingMode`:
    - `startFromPin(element: CircuitElement, pin: Pin)` — begin wire from this pin's world position
    - `updateCursor(worldPoint: Point)` — compute Manhattan route from last waypoint to cursor, update preview segments
    - `addWaypoint()` — lock current segment, start next from endpoint
    - `completeToPin(element: CircuitElement, pin: Pin, circuit: Circuit): Wire[]` — finalize wire, run consistency check, merge collinear segments, add to circuit
    - `cancel()` — discard in-progress wire
    - `getPreviewSegments(): { start: Point; end: Point }[]` — for rendering
  - `src/editor/wire-merge.ts` — `mergeCollinearSegments(wires: Wire[]): Wire[]` — if two adjacent wires are on the same horizontal or vertical line, replace with one wire spanning both
  - `src/editor/wire-consistency.ts` — `checkWireConsistency(circuit: Circuit, newWires: Wire[]): FacadeError | undefined` — validate no two output pins are connected to the same net (without a bus driver)

- **Tests**:
  - `src/editor/__tests__/wire-drawing.test.ts::WireDrawing::manhattanRouteHorizontalFirst` — start at (0,0), cursor at (5,3), preview has 2 segments: (0,0)→(5,0) and (5,0)→(5,3)
  - `src/editor/__tests__/wire-drawing.test.ts::WireDrawing::waypointLocksSegment` — start, move cursor, addWaypoint, move cursor further, verify previous segment is locked and new segment starts from waypoint
  - `src/editor/__tests__/wire-drawing.test.ts::WireDrawing::completeToPinAddsWires` — complete a wire, verify wires added to circuit
  - `src/editor/__tests__/wire-drawing.test.ts::WireDrawing::cancelDiscardsWire` — cancel mid-draw, verify no wires added
  - `src/editor/__tests__/wire-drawing.test.ts::WireMerge::mergesCollinearHorizontal` — two wires (0,0)→(5,0) and (5,0)→(10,0), merged to (0,0)→(10,0)
  - `src/editor/__tests__/wire-drawing.test.ts::WireMerge::doesNotMergeNonCollinear` — two wires at different y, both preserved
  - `src/editor/__tests__/wire-drawing.test.ts::WireConsistency::detectsShortedOutputs` — two output pins connected to same net, returns error

- **Acceptance criteria**:
  - Manhattan routing produces horizontal-then-vertical segments
  - Waypoints allow multi-segment wires
  - Collinear segments are merged
  - Consistency checker catches shorted outputs
  - All tests pass

---

## Wave 2.4: Core Edit Operations

### Task 2.4.1 — Move, Copy, Paste, Delete

- **Description**: Drag selected elements/wires with grid snap. Cut/Copy/Paste via Ctrl+X/C/V using an internal clipboard (not system clipboard — circuit elements aren't text). Delete key removes selection. Ctrl+D duplicates. Copy label renaming: when copying components with numeric suffixes, auto-increment (e.g., `Reg1` → `Reg2`). Port Digital's `CopiedElementLabelRenamer`.

- **Files to create**:
  - `src/editor/edit-operations.ts` — functions returning `EditCommand` objects (for undo integration):
    - `moveSelection(elements, wires, delta: Point): EditCommand`
    - `deleteSelection(circuit, elements, wires): EditCommand`
    - `copyToClipboard(elements, wires): ClipboardData`
    - `pasteFromClipboard(circuit, clipboard, position): EditCommand`
    - `duplicate(circuit, elements, wires): EditCommand`
  - `src/editor/label-renamer.ts` — `renameLabelsOnCopy(elements: CircuitElement[]): void` — for each element with a label property ending in a number, increment the number. If the new label already exists in the circuit, keep incrementing.

- **Tests**:
  - `src/editor/__tests__/edit-operations.test.ts::EditOps::moveUpdatesPositions` — move selection by (2,3), verify all element positions offset by (2,3)
  - `src/editor/__tests__/edit-operations.test.ts::EditOps::deleteRemovesFromCircuit` — delete 2 elements, verify circuit.elements.length decreased by 2
  - `src/editor/__tests__/edit-operations.test.ts::EditOps::copyPasteCreatesClones` — copy 1 element, paste, verify circuit has 2 elements with different instanceIds
  - `src/editor/__tests__/edit-operations.test.ts::EditOps::duplicateIsCopyPasteInPlace` — duplicate, verify new element at offset position
  - `src/editor/__tests__/edit-operations.test.ts::LabelRenamer::incrementsNumericSuffix` — "Reg1" → "Reg2"
  - `src/editor/__tests__/edit-operations.test.ts::LabelRenamer::skipsExistingLabels` — "Reg1" exists, "Reg2" exists, copies "Reg1" → "Reg3"
  - `src/editor/__tests__/edit-operations.test.ts::LabelRenamer::noSuffixNoRename` — "Clock" stays "Clock"

- **Acceptance criteria**:
  - Move snaps to grid
  - Copy/paste produces new instances with unique IDs
  - Label renaming auto-increments
  - Delete removes elements and their connected wires
  - All operations produce reversible `EditCommand` objects
  - All tests pass

---

### Task 2.4.2 — Undo/Redo

- **Description**: Command pattern for all edit operations. Every user action (move, delete, paste, place, connect, property change) produces a reversible `EditCommand`. Ctrl+Z undoes, Ctrl+Shift+Z redoes. Configurable stack depth (default 100). Redo stack clears when a new action is performed after undoing.

- **Files to create**:
  - `src/editor/undo-redo.ts`:
    - `EditCommand` interface: `{ execute(): void; undo(): void; description: string }`
    - `UndoRedoStack` class:
      - `push(command: EditCommand)` — execute and add to undo stack, clear redo stack
      - `undo(): boolean` — pop from undo, call undo(), push to redo. Returns false if nothing to undo
      - `redo(): boolean` — pop from redo, call execute(), push to undo. Returns false if nothing to redo
      - `canUndo(): boolean`, `canRedo(): boolean`
      - `clear()` — reset both stacks
      - `setMaxDepth(depth: number)` — trim undo stack from bottom if exceeding

- **Tests**:
  - `src/editor/__tests__/undo-redo.test.ts::UndoRedo::pushExecutesCommand` — push command, verify execute() called
  - `src/editor/__tests__/undo-redo.test.ts::UndoRedo::undoReversesCommand` — push, undo, verify undo() called
  - `src/editor/__tests__/undo-redo.test.ts::UndoRedo::redoReExecutes` — push, undo, redo, verify execute() called twice total
  - `src/editor/__tests__/undo-redo.test.ts::UndoRedo::newActionClearsRedoStack` — push A, undo A, push B, redo returns false (A is gone)
  - `src/editor/__tests__/undo-redo.test.ts::UndoRedo::maxDepthTrimsOldest` — set depth 2, push 3 commands, undo 3 times → third undo returns false
  - `src/editor/__tests__/undo-redo.test.ts::UndoRedo::canUndoCanRedo` — verify boolean state at each step

- **Acceptance criteria**:
  - All edit operations produce `EditCommand` objects
  - Undo reverses the operation, redo re-applies it
  - Stack depth is enforced
  - Redo stack clears on new action
  - All tests pass

---

### Task 2.4.3 — Component Palette

- **Description**: Tree-based component palette on the left panel. Categories from `ComponentCategory` enum as collapsible tree nodes. Components listed under their category. Click to enter placement mode. Search/filter input at top — typing filters the tree to matching component names. Recently placed history (last ~10 unique types, shown at top of palette). Collapsible for iframe-embedded mode.

- **Files to create**:
  - `src/editor/palette.ts` — `ComponentPalette`:
    - `constructor(registry: ComponentRegistry)`
    - `getTree(): PaletteNode[]` — returns tree structure: `{ category: ComponentCategory, label: string, children: ComponentDefinition[], expanded: boolean }`
    - `filter(query: string): PaletteNode[]` — filter tree, auto-expand matching categories, collapse empty ones
    - `recordPlacement(typeName: string)` — add to recent history
    - `getRecentHistory(): ComponentDefinition[]` — last 10 unique types
    - `toggleCategory(category: ComponentCategory)` — expand/collapse
    - `setCollapsed(collapsed: boolean)` — hide/show entire palette (for iframe mode)
  - `src/editor/palette-ui.ts` — DOM rendering for the palette (tree view, search input, recent section). Separated from logic for testability.

- **Tests**:
  - `src/editor/__tests__/palette.test.ts::Palette::treeGroupsByCategory` — register 3 components in 2 categories, verify tree has 2 nodes with correct children
  - `src/editor/__tests__/palette.test.ts::Palette::filterMatchesPartialName` — filter "An", verify "And" and "NAnd" visible, "Or" hidden
  - `src/editor/__tests__/palette.test.ts::Palette::filterIsCaseInsensitive` — filter "and" matches "And"
  - `src/editor/__tests__/palette.test.ts::Palette::recentHistoryTracksLastTen` — place 12 types, verify history has 10, most recent first
  - `src/editor/__tests__/palette.test.ts::Palette::recentHistoryDeduplicates` — place "And" twice, appears once in history
  - `src/editor/__tests__/palette.test.ts::Palette::collapseHidesPalette` — setCollapsed(true), verify collapsed state

- **Acceptance criteria**:
  - All registered components appear in correct category
  - Search filters in real-time
  - Recent history tracks last 10 unique types
  - Panel is collapsible
  - All tests pass

---

### Task 2.4.4 — Property Editor Panel

- **Description**: Right-side panel showing properties of the selected element. Type-appropriate inputs: number spinner for INT/BIT_WIDTH (with min/max), text input for STRING, dropdown for ENUM, checkbox for BOOLEAN, hex editor for HEX_DATA, color picker for COLOR. Changes apply immediately to the element (with undo support via `EditCommand`). Collapsible for iframe mode.

- **Files to create**:
  - `src/editor/property-panel.ts` — `PropertyPanel`:
    - `showProperties(element: CircuitElement, definitions: PropertyDefinition[])` — populate panel with inputs matching each property's type
    - `onPropertyChange(callback: (key: string, oldValue: PropertyValue, newValue: PropertyValue) => void)` — for undo integration
    - `clear()` — empty the panel (no selection)
    - `setCollapsed(collapsed: boolean)` — for iframe mode
  - `src/editor/property-inputs.ts` — input widget factory:
    - `createInput(definition: PropertyDefinition, currentValue: PropertyValue): PropertyInput`
    - `PropertyInput` interface: `{ element: HTMLElement; getValue(): PropertyValue; setValue(v: PropertyValue): void; onChange(cb): void }`
    - Specific implementations for each type: `NumberInput`, `TextInput`, `EnumSelect`, `BooleanCheckbox`, `HexDataEditor`, `ColorPicker`

- **Tests**:
  - `src/editor/__tests__/property-panel.test.ts::PropertyPanel::showsAllProperties` — element with 3 properties, panel creates 3 inputs
  - `src/editor/__tests__/property-panel.test.ts::PropertyPanel::numberInputRespectsMinMax` — INT property with min=1, max=8: input clamps values
  - `src/editor/__tests__/property-panel.test.ts::PropertyPanel::enumInputShowsOptions` — ENUM property with 3 values, dropdown has 3 options
  - `src/editor/__tests__/property-panel.test.ts::PropertyPanel::changeFiresCallback` — modify a property, verify callback fires with old and new value
  - `src/editor/__tests__/property-panel.test.ts::PropertyPanel::clearEmptiesPanel` — clear, verify no inputs remain
  - `src/editor/__tests__/property-panel.test.ts::PropertyPanel::collapseHidesPanel` — setCollapsed(true), verify collapsed state

- **Acceptance criteria**:
  - Each `PropertyType` has an appropriate input widget
  - Changes are immediately reflected on the element
  - Change callback provides old/new values for undo
  - Panel is collapsible
  - All tests pass

---

### Task 2.4.5 — Context Menus and Keyboard Shortcuts

- **Description**: Right-click context menus with relevant actions based on what was clicked (element: rotate, mirror, delete, copy, properties, help; wire: delete, split; canvas: paste, select all). Keyboard shortcut system with configurable bindings. Default bindings match Digital where applicable.

- **Files to create**:
  - `src/editor/context-menu.ts` — `ContextMenu`:
    - `show(position: Point, target: HitResult, actions: MenuAction[])` — render menu at screen position with relevant actions
    - `hide()` — dismiss menu
    - `MenuAction`: `{ label: string; shortcut?: string; action: () => void; enabled: boolean }`
    - Factory: `buildMenuForElement(element)`, `buildMenuForWire(wire)`, `buildMenuForCanvas()`
  - `src/editor/shortcuts.ts` — `ShortcutManager`:
    - `register(key: string, modifiers: Modifier[], action: () => void, description: string)`
    - `handleKeyDown(event: KeyboardEvent): boolean` — returns true if handled
    - Default bindings: Delete, Ctrl+Z, Ctrl+Shift+Z, Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+D, Ctrl+A, Escape, R (rotate), M (mirror), Ctrl+F (search), F4 (presentation), Space (hold = pan mode)
    - `getBindings(): ShortcutBinding[]` — for settings display

- **Tests**:
  - `src/editor/__tests__/context-menu.test.ts::ContextMenu::elementMenuHasRotateDelete` — right-click element, verify menu includes Rotate, Mirror, Delete, Copy, Properties, Help
  - `src/editor/__tests__/context-menu.test.ts::ContextMenu::wireMenuHasDelete` — right-click wire, verify menu includes Delete
  - `src/editor/__tests__/context-menu.test.ts::ContextMenu::canvasMenuHasPaste` — right-click canvas, verify menu includes Paste, Select All
  - `src/editor/__tests__/shortcuts.test.ts::Shortcuts::ctrlZCallsUndo` — simulate Ctrl+Z keydown, verify undo action called
  - `src/editor/__tests__/shortcuts.test.ts::Shortcuts::rRotatesSelection` — simulate R keydown with element selected, verify rotate action called
  - `src/editor/__tests__/shortcuts.test.ts::Shortcuts::unknownKeyReturnsFalse` — unbound key, handleKeyDown returns false

- **Acceptance criteria**:
  - Context menus show relevant actions for the clicked target
  - All default shortcuts work
  - Shortcut map is queryable (for settings/help display)
  - All tests pass

---

## Wave 2.5: Extended Editor Features

### Task 2.5.1 — Find/Search

- **Description**: Ctrl+F opens search bar. Type to search component labels, type names, and tunnel names. Matches are highlighted on the canvas. Arrow keys navigate between matches. Enter/click centers viewport on the selected match. Escape closes search.

- **Files to create**:
  - `src/editor/search.ts` — `CircuitSearch`:
    - `search(circuit: Circuit, query: string): SearchResult[]` — returns matching elements with match type (label, typeName, tunnelName) and match range
    - `SearchResult`: `{ element: CircuitElement; matchType: string; matchText: string }`
    - `navigateTo(result: SearchResult, viewport: Viewport)` — center viewport on result element

- **Tests**:
  - `src/editor/__tests__/search.test.ts::Search::findsByLabel` — element with label "Counter1", search "counter", returns match
  - `src/editor/__tests__/search.test.ts::Search::findsByTypeName` — search "And", returns all And gates
  - `src/editor/__tests__/search.test.ts::Search::caseInsensitive` — search "and" matches "And"
  - `src/editor/__tests__/search.test.ts::Search::noMatchReturnsEmpty` — search "xyz", returns empty array
  - `src/editor/__tests__/search.test.ts::Search::navigateToCentersViewport` — navigate to result, verify viewport.fitToContent called or pan adjusted

- **Acceptance criteria**:
  - Search matches labels, type names, and tunnel names
  - Case-insensitive
  - Navigation centers the viewport on the match
  - All tests pass

---

### Task 2.5.2 — Label Tools

- **Description**: Utilities for managing component labels. Numbering wizard: auto-assign sequential numbers to selected components' labels (e.g., select 5 registers → label them Reg0–Reg4). Add/remove label prefix in batch. Pin ordering: reorder input/output pin ordering for a component. Tunnel rename: when renaming a tunnel, offer to rename all tunnels with the same name.

- **Files to create**:
  - `src/editor/label-tools.ts`:
    - `autoNumberLabels(elements: CircuitElement[], prefix: string, startFrom: number): EditCommand` — set label property to `prefix + i` for each element
    - `addLabelPrefix(elements: CircuitElement[], prefix: string): EditCommand`
    - `removeLabelPrefix(elements: CircuitElement[], prefix: string): EditCommand`
    - `renameTunnel(circuit: Circuit, oldName: string, newName: string): EditCommand` — rename all tunnel components with matching name

- **Tests**:
  - `src/editor/__tests__/label-tools.test.ts::LabelTools::autoNumbersSequentially` — 3 elements, prefix "R", start 1 → labels "R1", "R2", "R3"
  - `src/editor/__tests__/label-tools.test.ts::LabelTools::addsPrefixToAllLabels` — prefix "ALU_" → "Reg" becomes "ALU_Reg"
  - `src/editor/__tests__/label-tools.test.ts::LabelTools::removesPrefixFromLabels` — remove "ALU_" from "ALU_Reg" → "Reg"
  - `src/editor/__tests__/label-tools.test.ts::LabelTools::tunnelRenameAffectsAllInstances` — 3 tunnels named "Data", rename to "DataBus", all 3 updated

- **Acceptance criteria**:
  - All operations produce reversible `EditCommand` objects
  - Tunnel rename is circuit-wide
  - All tests pass

---

### Task 2.5.3 — Insert Selection as Subcircuit

- **Description**: Define the interface and boundary-analysis logic for converting a selection into a subcircuit. The actual subcircuit component type is created in Phase 6 (task 6.2.1). This task implements: (1) boundary wire analysis — identify wires crossing the selection boundary, determine direction (input/output) from pin directions, (2) interface pin generation — create `In`/`Out` pin specs at boundary crossing points, (3) circuit extraction — copy selected elements + internal wires into a new `Circuit` with the generated interface pins. The final step (replacing the selection with a subcircuit instance and registering the new subcircuit definition) is a stub that throws `FacadeError("Subcircuit component type not yet available")` until Phase 6 provides it. Phase 6 task 6.2.1 must implement the `SubcircuitComponent` type that this interface expects.

- **Files to create**:
  - `src/editor/insert-subcircuit.ts`:
    - `analyzeBoundary(circuit: Circuit, selectedElements: CircuitElement[], selectedWires: Wire[]): BoundaryAnalysis` — returns `{ boundaryWires: { wire: Wire; direction: PinDirection; pinLabel: string; bitWidth: number }[]; internalWires: Wire[] }`
    - `extractSubcircuit(selectedElements: CircuitElement[], internalWires: Wire[], boundaryPins: PinDeclaration[]): Circuit` — creates a new Circuit containing the selected items and boundary interface pins
    - `insertAsSubcircuit(circuit: Circuit, selectedElements: CircuitElement[], selectedWires: Wire[]): { subcircuit: Circuit; command: EditCommand }` — orchestrates the above, then attempts to replace selection with subcircuit instance. **Stub**: the replacement step throws until Phase 6 registers the subcircuit component type.

- **Tests**:
  - `src/editor/__tests__/insert-subcircuit.test.ts::InsertSubcircuit::analyzesBoundaryWires` — select 2 elements with 1 wire crossing boundary, verify `analyzeBoundary` returns that wire with correct direction and bit width
  - `src/editor/__tests__/insert-subcircuit.test.ts::InsertSubcircuit::classifiesInternalWires` — wire with both endpoints on selected elements, verify classified as internal
  - `src/editor/__tests__/insert-subcircuit.test.ts::InsertSubcircuit::extractsCircuitWithBoundaryPins` — extract, verify new Circuit has the selected elements plus In/Out elements for boundary pins
  - `src/editor/__tests__/insert-subcircuit.test.ts::InsertSubcircuit::preservesInternalWiring` — internal wires are present in the extracted circuit
  - `src/editor/__tests__/insert-subcircuit.test.ts::InsertSubcircuit::insertThrowsUntilPhase6` — full `insertAsSubcircuit` call throws `FacadeError` with message about subcircuit type not available

- **Acceptance criteria**:
  - Boundary analysis correctly identifies crossing wires and their directions
  - Circuit extraction produces a valid Circuit with interface pins
  - Full insertion is a documented stub until Phase 6
  - All tests pass

---

### Task 2.5.4 — Auto Power Supply

- **Description**: Scan circuit for components with unconnected power pins (VDD, GND). Auto-add VDD and GND components connected to those pins. A convenience tool, not automatic — user triggers it from a menu.

- **Files to create**:
  - `src/editor/auto-power.ts`:
    - `findUnconnectedPowerPins(circuit: Circuit): { element: CircuitElement; pin: Pin }[]`
    - `autoConnectPower(circuit: Circuit): EditCommand` — add VDD/GND components and wires for each unconnected power pin

- **Tests**:
  - `src/editor/__tests__/auto-power.test.ts::AutoPower::findsUnconnectedPowerPins` — circuit with element having unconnected VDD pin, returns that pin
  - `src/editor/__tests__/auto-power.test.ts::AutoPower::addsVddAndGnd` — auto-connect, verify VDD/GND elements and wires added to circuit
  - `src/editor/__tests__/auto-power.test.ts::AutoPower::skipsAlreadyConnected` — pin already connected to a wire, not included in results

- **Acceptance criteria**:
  - Correctly identifies unconnected power pins
  - Adds appropriate VDD/GND components
  - Undoable
  - All tests pass

---

### Task 2.5.5 — Element Help Dialog

- **Description**: Right-click any component → "Help" → show documentation dialog. Content sourced from `element.getHelpText()` and the component's `PropertyDefinition` list. Shows: description, pin table (name, direction, width), property table (name, type, default), behavior notes/truth table where applicable.

- **Files to create**:
  - `src/editor/element-help.ts`:
    - `buildHelpContent(element: CircuitElement, definition: ComponentDefinition): HelpContent`
    - `HelpContent`: `{ title: string; description: string; pinTable: PinInfo[]; propertyTable: PropInfo[]; helpText: string }`
  - `src/editor/element-help-ui.ts` — DOM rendering for the help dialog (modal overlay)

- **Tests**:
  - `src/editor/__tests__/element-help.test.ts::ElementHelp::includesPinTable` — mock element with 3 pins, verify pinTable has 3 entries with correct labels/directions
  - `src/editor/__tests__/element-help.test.ts::ElementHelp::includesPropertyTable` — mock element with 2 properties, verify propertyTable has 2 entries
  - `src/editor/__tests__/element-help.test.ts::ElementHelp::includesHelpText` — verify helpText from element.getHelpText() is included

- **Acceptance criteria**:
  - Help content is complete (pins, properties, description)
  - Dialog renders as a modal
  - All tests pass

---

### Task 2.5.6 — Presentation Mode

- **Description**: F4 toggles presentation mode. Fullscreen canvas (palette, property panel, toolbar hidden). Components rendered at increased scale for projection. Simplified toolbar (just simulation controls: play, pause, step, reset). Exit with F4 or Escape.

- **Files to create**:
  - `src/editor/presentation.ts` — `PresentationMode`:
    - `enter(viewport: Viewport)` — hide panels, set zoom to fit-to-circuit, show minimal sim toolbar
    - `exit()` — restore panels and zoom
    - `isActive(): boolean`
    - `getToolbarActions(): MenuAction[]` — play, pause, step, reset only

- **Tests**:
  - `src/editor/__tests__/presentation.test.ts::Presentation::enterHidesPanels` — enter, verify palette and property panel collapsed
  - `src/editor/__tests__/presentation.test.ts::Presentation::enterFitsContent` — enter, verify viewport.fitToContent was called
  - `src/editor/__tests__/presentation.test.ts::Presentation::exitRestoresPanels` — enter then exit, verify panels restored
  - `src/editor/__tests__/presentation.test.ts::Presentation::toolbarHasSimControlsOnly` — getToolbarActions returns play, pause, step, reset

- **Acceptance criteria**:
  - F4 toggles presentation mode
  - All panels hide on enter, restore on exit
  - Minimal toolbar shows sim controls
  - All tests pass

---

### Task 2.5.7 — Color Scheme Framework

- **Description**: Runtime color scheme switching. The three built-in schemes (default, high-contrast, monochrome) are already defined in Phase 1. This task adds: the ability to select scheme at runtime (triggers full re-render), IEEE vs IEC/DIN gate shape toggle (global setting, affects all gate rendering — gates check this setting in their `draw()` method), and a color scheme editor (custom colors for each ThemeColor).

- **Files to create**:
  - `src/editor/color-scheme.ts` — `ColorSchemeManager`:
    - `getActive(): ColorScheme`
    - `setActive(name: string)` — switch scheme, notify listeners
    - `getGateShapeStyle(): 'ieee' | 'iec'`
    - `setGateShapeStyle(style: 'ieee' | 'iec')` — notify listeners
    - `createCustomScheme(name: string, colors: Record<ThemeColor, string>): ColorScheme`
    - `onChange(callback)` — for triggering re-renders

- **Tests**:
  - `src/editor/__tests__/color-scheme.test.ts::ColorSchemeManager::switchesScheme` — set "high-contrast", verify getActive resolves BACKGROUND to #000000
  - `src/editor/__tests__/color-scheme.test.ts::ColorSchemeManager::gateShapeToggle` — set "iec", verify getGateShapeStyle returns "iec"
  - `src/editor/__tests__/color-scheme.test.ts::ColorSchemeManager::customSchemeWorks` — create custom with red background, verify resolves correctly
  - `src/editor/__tests__/color-scheme.test.ts::ColorSchemeManager::onChangeFiresOnSwitch` — switch scheme, verify callback fired

- **Acceptance criteria**:
  - Scheme switching triggers listener callbacks
  - IEEE/IEC toggle is a separate global setting
  - Custom schemes can override any ThemeColor
  - All tests pass

---

### Task 2.5.8 — Settings Dialog

- **Description**: Application preferences dialog. Settings: grid size (default 1), default gate delay, color scheme selection, language (i18n — placeholder until Phase 9), simulation speed, default display radix (hex/dec/bin/signed), gate shape style (IEEE/IEC), snap-to-grid toggle. Persist to `localStorage`. Load on startup.

- **Files to create**:
  - `src/editor/settings.ts` — `AppSettings`:
    - `get<T>(key: SettingKey): T`, `set(key: SettingKey, value)`, `reset(key: SettingKey)` — typed access
    - `save()` — write to localStorage
    - `load()` — read from localStorage, apply defaults for missing keys
    - `SettingKey` enum: `GRID_SIZE`, `DEFAULT_DELAY`, `COLOR_SCHEME`, `LANGUAGE`, `SIM_SPEED`, `DEFAULT_RADIX`, `GATE_SHAPE`, `SNAP_TO_GRID`
    - `onChange(key, callback)` — per-setting listeners
  - `src/editor/settings-ui.ts` — settings dialog DOM (modal with form inputs for each setting)

- **Tests**:
  - `src/editor/__tests__/settings.test.ts::Settings::defaultValues` — each setting has a sensible default
  - `src/editor/__tests__/settings.test.ts::Settings::persistsToLocalStorage` — set value, save, create new instance, load, verify value persisted (mock localStorage)
  - `src/editor/__tests__/settings.test.ts::Settings::resetRestoresDefault` — set value, reset, verify default restored
  - `src/editor/__tests__/settings.test.ts::Settings::onChangeFiresOnSet` — register callback for GRID_SIZE, set it, verify fired

- **Acceptance criteria**:
  - All settings have defaults
  - Settings persist across sessions via localStorage
  - Per-setting change listeners work
  - All tests pass

---

### Task 2.5.9 — File History

- **Description**: Track recently opened files. Show in File menu as a "Recent" submenu. Persist to localStorage. Maximum 10 entries.

- **Files to create**:
  - `src/editor/file-history.ts` — `FileHistory`:
    - `add(path: string)` — add to front, deduplicate, trim to 10
    - `getRecent(): string[]` — most recent first
    - `clear()` — empty history
    - `save()` / `load()` — localStorage persistence

- **Tests**:
  - `src/editor/__tests__/file-history.test.ts::FileHistory::addsToFront` — add "a.dig", "b.dig", verify getRecent returns ["b.dig", "a.dig"]
  - `src/editor/__tests__/file-history.test.ts::FileHistory::deduplicates` — add "a.dig" twice, appears once
  - `src/editor/__tests__/file-history.test.ts::FileHistory::trimsToTen` — add 12 files, verify only 10 in history
  - `src/editor/__tests__/file-history.test.ts::FileHistory::persistsToLocalStorage` — save, new instance, load, verify history preserved

- **Acceptance criteria**:
  - Most recent first, max 10, deduplicated
  - Persists via localStorage
  - All tests pass

---

### Task 2.5.10 — Locked Mode

- **Description**: Toggle that prevents circuit modification. In locked mode: users can toggle switches, press buttons, and observe outputs, but cannot add, move, delete, or edit components or wires. Essential for distributing tutorial circuits to students. Locked state is per-circuit (stored in `CircuitMetadata`). The editor checks `isLocked` before allowing any mutation.

- **Files to create**:
  - `src/editor/locked-mode.ts` — `LockedModeGuard`:
    - `isLocked(): boolean`
    - `setLocked(locked: boolean)` — toggle
    - `canEdit(): boolean` — returns `!isLocked()`
    - `canInteract(element: CircuitElement): boolean` — returns true for interactive components (In, Button, Switch, DipSwitch) even in locked mode
    - `guardMutation(operation: string): void` — throws if locked, with message like "Circuit is locked. Unlock to edit."

- **Files to modify**:
  - `src/core/circuit.ts` — add `isLocked: boolean` to `CircuitMetadata` interface and `defaultCircuitMetadata()` (default: `false`)

- **Tests**:
  - `src/editor/__tests__/locked-mode.test.ts::LockedMode::preventsEditing` — lock, call guardMutation, verify throws
  - `src/editor/__tests__/locked-mode.test.ts::LockedMode::allowsInteraction` — lock, canInteract with "In" element returns true
  - `src/editor/__tests__/locked-mode.test.ts::LockedMode::blocksNonInteractive` — lock, canInteract with "And" element returns false
  - `src/editor/__tests__/locked-mode.test.ts::LockedMode::unlockAllowsEditing` — lock, unlock, guardMutation does not throw

- **Acceptance criteria**:
  - Locked mode blocks all circuit mutations
  - Interactive components (switches, buttons) still respond
  - Lock state stored in circuit metadata
  - All tests pass

---

### Task 2.5.11 — Actual-to-Default and Fuse Reset

- **Description**: "Actual to Default" captures current simulation runtime values and saves them as the circuit's default component property values. "Restore Fuses" resets all blown fuses. Both are menu actions.

- **Files to create**:
  - `src/editor/runtime-to-defaults.ts`:
    - `captureRuntimeToDefaults(circuit: Circuit, signalAccess: WireSignalAccess): EditCommand` — for each component with observable outputs (registers, counters, etc.), capture current value and store as the property default
    - `restoreAllFuses(circuit: Circuit): EditCommand` — find all Fuse components, reset their "blown" state to false

- **Tests**:
  - `src/editor/__tests__/runtime-to-defaults.test.ts::RuntimeToDefaults::capturesCurrentValues` — mock element with value property, mock signal access returning value 42, capture, verify property default updated to 42
  - `src/editor/__tests__/runtime-to-defaults.test.ts::RuntimeToDefaults::restoresFuses` — circuit with 2 blown fuses, restore, verify both reset to not-blown
  - `src/editor/__tests__/runtime-to-defaults.test.ts::RuntimeToDefaults::undoableCapture` — capture, undo, verify defaults restored to original

- **Phase 6 note**: These tests use mocked `WireSignalAccess`. Phase 6 (engine-editor binding) should add integration tests that exercise `captureRuntimeToDefaults` with a real engine providing live signal values.

- **Acceptance criteria**:
  - Runtime values correctly captured as property defaults
  - Fuse reset is circuit-wide
  - Both operations are undoable
  - All tests pass

---

## Verification Criteria (Phase 2)

All of these must pass before Phase 6 integration:

- `npm run typecheck` passes with zero errors
- `npm test` — all new tests pass, all Phase 1 tests still pass
- `npm run lint` — browser-dep fence enforced (headless/core/engine/io/testing cannot import editor or use DOM globals)
- Circuit builder can programmatically construct a half-adder in Node.js (no browser)
- `FacadeError` messages are plain English with context
- Canvas renderer implements all `RenderContext` methods
- Hit-testing priority: pin > element > wire
- Undo/redo reverses/replays all edit operations
- Locked mode prevents mutations but allows interactive component use
- All panels (palette, property, toolbar) are collapsible for iframe embedding
- `npm run build` produces static output
