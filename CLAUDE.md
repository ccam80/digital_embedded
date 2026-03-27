# digiTS

## Project Overview

A browser-based digital logic circuit simulator. Purely static files, no server, no licensing dependencies.

### Engine-Agnostic Editor (Architectural Constraint)

The editor/renderer/interaction layer MUST be engine-agnostic. The same canvas, grid, component placement, wire routing, selection, undo/redo, and property editing code must work with **any** simulation backend. 

Concretely:
- No simulation logic in canvas/editor code
- Simulation engine is a pluggable interface (start, stop, step, read/write signal values)
- Components do not declare an engine type — the unified compiler derives the simulation domain (digital/analog) from each component's registered models
- Editor calls engine through the interface, never directly
- Components program against abstract `RenderContext` and engine interfaces, not Canvas2D or engine implementations

## Serving Locally

**All files MUST be served over HTTP**, not opened as `file://` URLs.

~~~bash
python3 -m http.server 8080
~~~

## postMessage API (tutorial host ↔ simulator iframe)

All postMessage handling is centralized in `src/io/postmessage-adapter.ts` (single source of truth). App-init.ts wires it up with GUI hooks — no inline message handlers.

~~~
Parent → iframe (core):
  { type: 'sim-load-url', url: '<url>' }          — Load a .dig circuit file
  { type: 'sim-load-data', data: '<base64>' }     — Load inline circuit data (base64 .dig XML)
  { type: 'sim-load-json', data: '<json>' }       — Load DTS format circuit
  { type: 'sim-set-input', label, value }          — Drive an input pin by label
  { type: 'sim-step' }                             — Single propagation step
  { type: 'sim-read-output', label }               — Read output signal by label
  { type: 'sim-read-all-signals' }                 — Snapshot all labeled signals
  { type: 'sim-run-tests', testData? }             — Run test vectors (headless)
  { type: 'sim-get-circuit' }                      — Export current circuit as base64
  { type: 'sim-set-base', basePath: '<path>' }    — Set HTTP base path for file resolution
  { type: 'sim-set-locked', locked: true|false }  — Lock/unlock editor
  { type: 'sim-load-memory', label, data, format } — Load data into RAM/ROM
  { type: 'sim-set-palette', components: [...] }  — Restrict palette to listed types (null = show all)

Parent → iframe (tutorial):
  { type: 'sim-test', testData: '<test vectors>' }              — Run test vectors with label validation
  { type: 'sim-highlight', labels: [...], duration?: ms }       — Highlight components by label
  { type: 'sim-clear-highlight' }                                — Clear all highlights
  { type: 'sim-set-readonly-components', labels: [...] | null } — Lock specific components
  { type: 'sim-set-instructions', markdown: '...' | null }      — Show/hide instructions panel

Iframe → parent:
  { type: 'sim-ready' }                        — Simulator initialized
  { type: 'sim-loaded' }                       — Circuit/setting applied
  { type: 'sim-error', error: '...' }          — Error occurred
  { type: 'sim-test-result', passed, failed, total, details: [...] }  — Test results
  { type: 'sim-output', label, value }         — Response to sim-read-output
  { type: 'sim-signals', signals: {...} }      — Response to sim-read-all-signals
  { type: 'sim-circuit-data', data: '<base64>', format: 'dig-xml-base64' }  — Circuit export
~~~

## Tutorial System

Structured tutorial authoring and runtime for step-by-step circuit-building exercises.

### Key Files

| File | Purpose |
|------|---------|
| `src/app/tutorial/types.ts` | Tutorial data model — `TutorialManifest`, `TutorialStep`, type guards |
| `src/app/tutorial/validate.ts` | Manifest validation against registry |
| `src/app/tutorial/presets.ts` | Named palette presets (`basic-gates`, `sequential-intro`, etc.) |
| `src/app/tutorial/tutorial-host.ts` | Tutorial host page manager |

### MCP Tools

| Tool | Purpose |
|------|---------|
| `tutorial_list_presets` | List available palette presets with their components |
| `tutorial_validate` | Validate a manifest JSON against schema + registry |
| `tutorial_create` | Create a complete tutorial package (validate, build circuits, verify tests, write files) |
| `circuit_test_equivalence` | Check behavioral equivalence of two circuits (exhaustive) |

### Authoring Workflow

1. Use `tutorial_list_presets` to pick palette presets for each step
2. Use `circuit_build` + `circuit_test` to develop and verify goal circuits
3. Assemble a `TutorialManifest` JSON (see template in `src/app/tutorial/types.ts`)
4. Use `tutorial_validate` to check for errors
5. Use `tutorial_create` to generate the tutorial package (manifest.json + .dig files)

### Tutorial Manifest Structure

~~~json
{
  "id": "sr-to-flipflop",
  "version": 1,
  "title": "From SR Latch to D Flip-Flop",
  "description": "Build sequential logic from first principles.",
  "difficulty": "intermediate",
  "steps": [{
    "id": "step-1-sr-latch",
    "title": "Build an SR Latch",
    "instructions": "# SR Latch\nUsing two NAND gates...",
    "palette": "nand-only",
    "startCircuit": null,
    "goalCircuit": { "components": [...], "connections": [...] },
    "validation": "test-vectors",
    "testData": "S R | Q nQ\n0 1 | 1 0\n1 0 | 0 1"
  }]
}
~~~

## Headless Architecture

All programmatic access (MCP server, postMessage bridge, CLI, tests) goes through `DefaultSimulatorFacade` — the single unified entry point. It composes three internal modules:

| Module | Class | Purpose |
|--------|-------|---------|
| Builder | `CircuitBuilder` | Create/patch circuits, netlist introspection, component registry queries |
| Runner | `SimulationRunner` | Compile → engine, step/run/runToStable, label-based signal I/O (WeakMap tracks engine↔compiled records) |
| Loader | `SimulationLoader` | Load .dig XML or JSON — environment-aware (Node.js `fs.readFile` / browser `fetch`) |

`DefaultSimulatorFacade` also owns engine lifecycle (fresh engine per `compile()`, clock management, dispose) and delegates test execution to `TestRunner` (resolves test data → parses → executes via `testing/executor`).

**Consumers:**

| Consumer | How it uses the facade |
|----------|----------------------|
| MCP server (`scripts/circuit-mcp-server.ts`) | Creates one `DefaultSimulatorFacade`, holds circuits in a handle map |
| PostMessage adapter (`src/io/postmessage-adapter.ts`) | Creates own facade for headless mode; GUI mode injects hooks that delegate to app-init's facade |
| App-init (`src/app/app-init.ts`) | Creates a `DefaultSimulatorFacade`, wires it into the editor binding and postMessage hooks |
| Tests | Import `DefaultSimulatorFacade` directly |

## Agent Circuit API

A string-addressed facade for LLM agents to inspect and modify circuits without touching wire coordinates or object references.

### CRITICAL: How to Work with Circuits

**NEVER read .dig XML files directly to understand circuit topology.** The XML contains wire coordinates, pixel positions, and rendering metadata — none of which tells you what's connected to what. Reading XML to debug a circuit is like reading a bitmap to understand a spreadsheet.

**ALWAYS use the MCP circuit tools.** The circuit simulator MCP server (`scripts/circuit-mcp-server.ts`) keeps circuits in memory across tool calls. Load once, then inspect/patch/compile without re-parsing.

**MCP tools:**

| Tool | Input | Output |
|------|-------|--------|
| `circuit_list` | `{ category? }` | All component types grouped by category |
| `circuit_describe` | `{ typeName }` | Pin layout, properties (with descriptions, min/max), help text |
| `circuit_describe_file` | `{ path }` | Lightweight pin interface scan (In/Out) without full load |
| `circuit_load` | `{ path }` | Handle + summary |
| `circuit_netlist` | `{ handle }` | Components, nets with connectivity, diagnostics |
| `circuit_validate` | `{ handle }` | Diagnostics only |
| `circuit_patch` | `{ handle, ops, scope? }` | Post-patch diagnostics |
| `circuit_build` | `{ spec }` | Handle + diagnostics |
| `circuit_compile` | `{ handle }` | Success or structured errors |
| `circuit_test` | `{ handle, testData? }` | Pass/fail results |
| `circuit_test_equivalence` | `{ handleA, handleB, maxInputBits? }` | Exhaustive behavioral equivalence check |
| `circuit_save` | `{ handle, path, save_all? }` | Confirmation (optionally copies subcircuit files) |

**Discovery workflow:** `circuit_list` (browse types) → `circuit_describe` (learn pins + properties) → `circuit_build` (create)

**Edit workflow:** `circuit_load` → `circuit_netlist` (inspect) → `circuit_patch` (fix) → `circuit_validate` (confirm) → `circuit_compile` (simulate)

A width mismatch that takes 20 minutes to find by reading XML takes one `circuit_validate` call.

### MCP Server Config

Add to `.claude/mcp.json`:
~~~json
{
  "mcpServers": {
    "circuit-simulator": {
      "command": "npx",
      "args": ["tsx", "scripts/circuit-mcp-server.ts"],
      "cwd": "<project-root>"
    }
  }
}
~~~

### Read-Modify-Verify Workflow

```
1. circuit_load({ path })           → handle
2. circuit_netlist({ handle })      → components, nets, diagnostics
3. circuit_patch({ handle, ops })   → apply fixes, get new diagnostics
4. circuit_validate({ handle })     → confirm clean
5. circuit_compile({ handle })      → simulate / test
```

### Addressing Scheme

Everything uses the same string addresses — read format equals write format.

| Target | Address format | Example |
|--------|---------------|---------|
| Component | `"label"` (user label) or `"instanceId"` (fallback) | `"gate1"` |
| Pin | `"label:pinLabel"` | `"gate:A"`, `"sysreg:ADD"` |
| Subcircuit scope | `"parent/child"` prefix | `"cpu/alu:A"` |

If `netlist()` reports `sysreg:ADD [1-bit]`, the patch target is `{ op: 'set', target: 'ADD', props: { bitWidth: 16 } }`.

### Facade Methods (via `DefaultSimulatorFacade`)

Building:
- `createCircuit(opts?)` — create an empty circuit
- `addComponent(circuit, typeName, props?)` — add a component by type
- `connect(circuit, src, srcPin, dst, dstPin)` — wire two pins
- `build(spec)` — create a circuit from a declarative `CircuitSpec` (no coordinates required)
- `patch(circuit, ops, opts?)` — apply `PatchOp` edits using label:pin addressing; returns diagnostics

Simulation:
- `compile(circuit)` — compile to a `SimulationEngine` (fresh engine each call)
- `step(engine)` — one propagation cycle (with clock advancement for digital)
- `run(engine, cycles)` — N propagation cycles
- `runToStable(engine, maxIter?)` — run until signals stabilize
- `setInput(engine, label, value)` / `readOutput(engine, label)` / `readAllSignals(engine)` — label-based I/O

Introspection:
- `netlist(circuit)` — returns `Netlist` with components, nets (all connected pins per net), and diagnostics
- `validate(circuit)` — returns `Diagnostic[]`; convenience wrapper for `netlist().diagnostics`
- `describeComponent(typeName)` — queries registry for pin layout and configurable properties

Testing:
- `runTests(engine, circuit, testData?)` — execute test vectors (embedded or external)

File I/O:
- `loadDigXml(xml)` — parse .dig XML string → `Circuit`
- `serialize(circuit)` / `deserialize(json)` — JSON round-trip

### Patch Operations

| Op | Target | Purpose | Example |
|----|--------|---------|---------|
| `set` | component label | Change properties | `{"op":"set","target":"ADD","props":{"bitWidth":16}}` |
| `add` | — | Add component + wire it | `{"op":"add","spec":{"id":"U1","type":"And"},"connect":{"A":"in1:out"}}` |
| `remove` | component label | Remove component + wires | `{"op":"remove","target":"old_gate"}` |
| `connect` | `from`, `to` pins | Wire two pins | `{"op":"connect","from":"gate:out","to":"output:in"}` |
| `disconnect` | pin address | Remove wires at pin | `{"op":"disconnect","pin":"gate:out"}` |
| `replace` | component label | Swap type, keep wires | `{"op":"replace","target":"U1","newType":"Or"}` |

### Building New Circuits (`circuit_build`)

Pass a `CircuitSpec` to `circuit_build`. No coordinates — pure topology.

**CircuitSpec format:**

```
{
  "name": "optional circuit name",
  "components": [ ComponentSpec, ... ],
  "connections": [ ["srcId:pin", "dstId:pin"], ... ]
}
```

**ComponentSpec fields:**

| Field | Required | Purpose |
|-------|----------|---------|
| `id` | yes | Local reference for wiring (only used within this spec, not persisted) |
| `type` | yes | Registry type name — use `circuit_list` to browse, `circuit_describe` for details |
| `props` | no | Component properties — use `circuit_describe` to see available keys, types, defaults, and ranges |
| `layout` | no | Layout constraints: `{ col?, row? }`. `col` pins the column (0 = leftmost), `row` pins vertical position within the column (0 = topmost). Either/both/neither. Unconstrained axes are auto-assigned. |

**Discovering types and properties:**

1. `circuit_list()` → browse all 229 component types by category (LOGIC, IO, MEMORY, etc.)
2. `circuit_list({ category: "LOGIC" })` → filter to one category
3. `circuit_describe({ typeName: "NAnd" })` → get pin labels, property keys with types/defaults/min/max/descriptions

**Property keys** use internal names from `circuit_describe`. XML-convention keys (e.g. `Bits`) are also accepted and auto-translated via each component's `attributeMap`. Common internal keys:

| Property | Type | Used by | Purpose |
|----------|------|---------|---------|
| `label` | STRING | most types | Display label |
| `bitWidth` | BIT_WIDTH | gates, arithmetic, In, Out | Signal width (1–32). XML name: `Bits` |
| `dataBits` | BIT_WIDTH | ROM, RAM, EEPROM, LookupTable | Data width. XML name: `Bits` |
| `addrBits` | BIT_WIDTH | ROM, RAM, EEPROM | Address width. XML name: `AddrBits` |
| `selectorBits` | BIT_WIDTH | Mux, Demux, Decoder | Selector width. XML name: `Selector Bits` |
| `inputCount` | INT | gates | Number of inputs (2–5) |
| `_inverterLabels` | STRING | gates | Invert specific inputs: `"1,3"` or `"In_1,In_3"` |
| `defaultValue` | INT | In, Const | Initial value |

**Connections** are pairs of `"id:pinLabel"` strings. Pin labels must match the component type's declared pins exactly. Use `circuit_describe({ typeName: "..." })` to look up pin labels before connecting.

**Example** — 2-input AND gate with labeled I/O:

~~~json
{
  "components": [
    { "id": "A",    "type": "In",  "props": { "label": "A", "bitWidth": 1 } },
    { "id": "B",    "type": "In",  "props": { "label": "B", "bitWidth": 1 } },
    { "id": "gate", "type": "And" },
    { "id": "Y",    "type": "Out", "props": { "label": "Y" } }
  ],
  "connections": [
    ["A:out", "gate:In_1"],
    ["B:out", "gate:In_2"],
    ["gate:out", "Y:in"]
  ]
}
~~~

**Example** — NAND gate with inverted first input (no separate NOT needed):

~~~json
{ "id": "G1", "type": "NAnd", "props": { "_inverterLabels": "1" } }
~~~

**Example** — layout constraints to control placement:

~~~json
{
  "components": [
    { "id": "clk", "type": "Clock", "props": { "label": "CLK" }, "layout": { "col": 0, "row": 0 } },
    { "id": "D",   "type": "In",    "props": { "label": "D" },   "layout": { "col": 0 } },
    { "id": "ff",  "type": "FlipflopD", "layout": { "col": 1 } },
    { "id": "Q",   "type": "Out",   "props": { "label": "Q" },   "layout": { "col": 2 } }
  ],
  "connections": [["clk:out", "ff:C"], ["D:out", "ff:D"], ["ff:Q", "Q:in"]]
}
~~~

`col` controls the column (left-to-right order), `row` controls vertical position within a column. Use `col` alone for most cases — the auto-layouter handles vertical ordering. Add `row` when vertical position matters (e.g. clock always at top).

Circuits are automatically laid out left-to-right using Sugiyama-style graph layout when built via `circuit_build`. The layout engine handles crossing minimization, body-clearance wire routing, and feedback path routing. Layout constraints override the auto-assignment for pinned axes while the algorithm fills in the rest.

Common component types: `In`, `Out`, `And`, `Or`, `XOr`, `Not`, `NAnd`, `NOr`, `FlipflopD`, `FlipflopJK`, `Mux`, `Demux`, `Counter`, `Register`, `ROM`, `RAM`, `Const`, `Clock`, `Splitter`, `Tunnel`.

### Diagnostic Codes

| Code | Meaning |
|------|---------|
| `width-mismatch` | Connected pins have different bit widths |
| `unconnected-input` | Input pin has no driving source |
| `unconnected-output` | Output pin is not connected to anything |
| `multi-driver-no-tristate` | Multiple outputs drive the same net without tristate |
| `missing-subcircuit` | Referenced subcircuit file not found |
| `label-collision` | Two components share the same label |
| `combinational-loop` | Combinational path with no register break |
| `missing-property` | Required component property not set |
| `unknown-component` | Component type not found in registry |

### Key Files

| File | Purpose |
|------|---------|
| `scripts/circuit-mcp-server.ts` | MCP server — agent circuit interface |
| `scripts/circuit-cli.ts` | CLI tool — `list`, `describe`, `build`, `netlist`, `validate`, `compile`, `test` |
| `src/headless/facade.ts` | `SimulatorFacade` interface (contract) |
| `src/headless/default-facade.ts` | `DefaultSimulatorFacade` — unified concrete implementation |
| `src/headless/runner.ts` | `SimulationRunner` — compile, step/run, label-based signal I/O |
| `src/headless/loader.ts` | `SimulationLoader` — .dig XML and JSON loading (Node.js / browser) |
| `src/headless/builder.ts` | `CircuitBuilder` with `build()` and `patch()` |
| `src/headless/test-runner.ts` | `TestRunner` + `extractEmbeddedTestData()` |
| `src/headless/netlist-types.ts` | `Netlist`, `Diagnostic`, `CircuitSpec`, `PatchOp` types |
| `src/headless/netlist.ts` | `resolveNets()` implementation |
| `src/headless/address.ts` | Address resolution utilities |
| `src/headless/auto-layout.ts` | Sugiyama-style auto-layout engine for `build()` |
| `src/headless/types.ts` | `FacadeError`, `TestResults` |
| `src/headless/index.ts` | Public API exports |

### Design Principles

- **Never read .dig XML for topology** — use `circuit_netlist` / `circuit_validate` MCP tools
- **Same vocabulary for read and write** — netlist addresses = patch targets
- **Validate after every edit** — `patch()` returns diagnostics automatically
- **No object references** — everything is string-addressed for LLM compatibility
- **Diagnostics, not exceptions** — `validate()` collects all issues instead of throwing on the first

## Editor / UI Architecture

The browser UI is engine-agnostic — it works with any simulation backend via the `SimulationEngine` interface. All circuit mutations go through the command-pattern `UndoRedoStack` for undo/redo support.

### Rendering Pipeline

| Module | File | Purpose |
|--------|------|---------|
| `CanvasRenderer` | `src/editor/canvas-renderer.ts` | Implements `RenderContext` over Canvas2D — drawing primitives, color resolution |
| `ElementRenderer` | `src/editor/element-renderer.ts` | Iterates elements, applies transforms (rotation/mirror), delegates to `element.draw(ctx)`, draws pin indicators and selection highlights |
| `WireRenderer` | `src/editor/wire-renderer.ts` | Draws wire segments with signal-state coloring (HIGH/LOW/Z/UNDEFINED), junction dots, bus width markers, analog voltage gradients |
| `GridRenderer` | `src/editor/grid.ts` | Background grid |

The same `RenderContext` interface is implemented by `CanvasRenderer` (live canvas), `SVGRenderContext` (SVG export), and test mocks.

### Interaction Modes

| Mode | File | Trigger |
|------|------|---------|
| `SelectionModel` | `src/editor/selection.ts` | Default — click/box-select elements and wires, fires change listeners |
| `PlacementMode` | `src/editor/placement.ts` | Palette click — ghost follows cursor (grid-snapped), R rotates, M mirrors, click places |
| `WireDrawingMode` | `src/editor/wire-drawing.ts` | Click output pin — Manhattan-routed preview, waypoints, click input pin completes |
| `WireDragMode` | `src/editor/wire-drag.ts` | Drag wire segment — constrained perpendicular movement, dogleg routing |

### Coordinate System

`screenToWorld()` / `worldToScreen()` in `src/editor/coordinates.ts`. Grid spacing = 20 screen pixels per grid unit. All placements snap to 1-grid-unit increments.

`Viewport` (`src/editor/viewport.ts`) manages pan/zoom (range 0.1–10.0). Transform: `screen = world * zoom * GRID_SPACING + pan`.

### Editor Subsystems

| Module | File | Purpose |
|--------|------|---------|
| `UndoRedoStack` | `src/editor/undo-redo.ts` | Command-pattern stack (default depth 100). All mutations are reversible `EditCommand` objects |
| Edit operations | `src/editor/edit-operations.ts` | `moveSelection`, `rotateSelection`, `mirrorSelection`, `deleteSelection`, `copyToClipboard`, `pasteFromClipboard`, `placeComponent` |
| `PropertyPanel` | `src/editor/property-panel.ts` | Right-side panel showing properties of selected element with undo integration |
| `ComponentPalette` | `src/editor/palette.ts` | Pure logic — category tree, search/filter, recent history, allowlist filtering |
| `PaletteUI` | `src/editor/palette-ui.ts` | DOM rendering for palette — tree view, search input, touch drag-to-place |
| `LockedModeGuard` | `src/editor/locked-mode.ts` | Read-only mode — disables editing interactions |
| `ColorSchemeManager` | `src/editor/color-scheme.ts` | Theme management (light/dark/high-contrast/monochrome) |
| `TouchGestureTracker` | `src/editor/touch-gestures.ts` | Pinch zoom, two-finger pan, single-touch selection |
| Hit testing | `src/editor/hit-test.ts` | Priority: pin > element > wire > none. Min click target 1.5 grid units |
| `autoConnectPower` | `src/editor/auto-power.ts` | Auto-inserts power/ground for dangling inputs/outputs |

### Integration Layer

| Module | File | Purpose |
|--------|------|---------|
| `EditorBinding` | `src/integration/editor-binding.ts` | Bridges compiled engine ↔ editor: wire→`SignalAddress` and pin→`SignalAddress` mappings; reads signals via `SimulationCoordinator` for live signal display, writes via `coordinator.writeSignal()` for input driving |
| `SpeedControl` | `src/integration/speed-control.ts` | Simulation speed (1–10M steps/sec) with text parsing |

### Runtime Panels

| Panel | File | Purpose |
|-------|------|---------|
| `DataTablePanel` | `src/runtime/data-table.ts` | Live tabular signal view with configurable radix (dec/hex/bin/oct), grouped by type |
| `TimingDiagramPanel` | `src/runtime/timing-diagram.ts` | Waveform view — records samples per step, time cursor, zoom/pan, snapshot integration |
| `AnalogScopePanel` | `src/runtime/analog-scope-panel.ts` | Oscilloscope — voltage/current channels, auto Y-range, envelope decimation, FFT spectrum view |
| `BodePlotRenderer` | `src/runtime/bode-plot.ts` | Bode magnitude/phase plots from AC analysis — -3dB detection, phase margin markers |

All runtime panels implement `MeasurementObserver` (`onStep()`, `onReset()`).

### Analysis Tools

| Module | File | Purpose |
|--------|------|---------|
| `analyseCircuit()` | `src/analysis/model-analyser.ts` | Enumerates all 2^N input combinations → truth table (max 20 input bits) |
| `TruthTable` | `src/analysis/truth-table.ts` | Data model with ternary values (0/1/don't-care), change events |
| `TruthTableTab` | `src/analysis/truth-table-ui.ts` | UI controller for truth table display |
| `KarnaughMapTab` | `src/analysis/karnaugh-map.ts` | K-map visualization (2–6 vars), Gray code ordering, prime implicant loop rendering |

### Export

| Format | File | Notes |
|--------|------|-------|
| SVG | `src/export/svg.ts` | Uses `SVGRenderContext`; optional live signal coloring |
| PNG | `src/export/png.ts` | Canvas render → PNG blob |
| GIF | `src/export/gif.ts` | Animated circuit states from timing diagram snapshots |
| ZIP | `src/export/zip.ts` | Bundles circuit + diagrams |

## Tests

### Framework

| Type | Framework | Config | Pattern |
|------|-----------|--------|---------|
| Unit / Integration | Vitest 2.0 | `vitest.config.ts` | `src/**/__tests__/*.test.ts` |
| E2E | Playwright | `playwright.config.ts` | `e2e/**/*.spec.ts` |

### Commands

| Command | Purpose |
|---------|---------|
| `npm test` | Run all tests (Vitest unit/integration + Playwright E2E) |
| `npm run test:watch` | Vitest watch mode (unit/integration only) |

### Three-Surface Testing Rule

**Every user-facing feature MUST be tested across all three surfaces:**

1. **Headless API test** (`src/**/__tests__/*.test.ts`) — Import `DefaultSimulatorFacade`, call methods directly, assert results. This validates the core logic without any transport layer.

2. **MCP tool test** (`src/**/__tests__/*.test.ts` or dedicated MCP test file) — Exercise the feature through the MCP server's tool handlers (same code paths as `scripts/circuit-mcp-server.ts`). This validates the agent-facing contract: serialization, handle management, error formatting.

3. **E2E / UI test** (`e2e/**/*.spec.ts`) — Drive the feature through simulated mouse/keyboard interaction in the browser via Playwright. For postMessage-driven features, use the `SimulatorHarness` fixture (`e2e/fixtures/simulator-harness.ts`) to send messages and assert responses. This validates the full stack including DOM rendering, event handling, and the postMessage wire protocol.

**Why all three?** A feature can work in the headless API but break in MCP serialization. It can work in MCP but fail in the browser due to DOM wiring. Testing all three surfaces catches integration gaps at each boundary.

### E2E Test Structure

| Category | Directory | Purpose |
|----------|-----------|---------|
| GUI tests | `e2e/gui/` | Browser interaction — canvas, palette, menus, simulation controls, circuit building |
| Parity tests | `e2e/parity/` | PostMessage API — load circuits, set-input/step/read-output, error handling |

**SimulatorHarness** (`e2e/fixtures/simulator-harness.ts`) wraps the postMessage protocol for E2E tests: `loadDigXml()`, `loadDigUrl()`, `postToSim()`, `waitForMessage()`, `runTests()`, `getCircuit()`.
