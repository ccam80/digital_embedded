# Digital-in-Browser — Implementation Plan

Native TypeScript port of hneemann/Digital: a complete circuit editor, compiled and event-driven simulation engine, ~110 component types, HGS scripting for parameterized circuits, circuit analysis and synthesis, FSM editor, test framework, and .dig file compatibility — deployed as purely static browser files.

**Reference source**: `ref/Digital/` (git submodule, pinned commit). Agents read Java source and write idiomatic TypeScript equivalents — informed port, not line-by-line translation.

**Author instructions**: `spec/author_instructions.md` — TS idiom guide, priority order (architectural consistency > performance > implementation ease), review checkpoints, component implementation template. All agents must read before writing code.

## Goals

- A Canvas-based circuit editor with all of Digital's editing features: placement, wiring, selection, undo/redo, property editing, component palette, bus value annotations, search, label tools, presentation mode, locked mode, color schemes, settings
- A pluggable simulation engine with three modes: level-by-level (default, SCC-aware topological sweep), timed (per-component propagation delays via timing wheel), and micro-step (one gate per step for teaching). SCC decomposition handles combinational feedback. Noise mode for non-deterministic startup. Bus resolution subsystem for tri-state nets. Web Worker-compatible architecture.
- The full Digital component library (~110 types) including display components, custom SVG shapes, Tunnel named connections, and parameterized generic circuits via HGS scripting
- Runtime inspection tools: live data table, timing diagram, measurement ordering, wire tooltips, memory hex editor, live memory viewer, program loader
- .dig XML import with full component coverage, InverterConfig support, and native JSON save/load
- Subcircuit support: hierarchical embedding, recursive loading, engine flattening, generic/parameterized resolution via HGS
- HGS scripting interpreter: full port of Digital's Hardware Generation Script (~3,150 lines, 25 files) for parameterized circuit instantiation
- Test framework: truth table parser, test executor, test case editor, run-all, folder runner, behavioral fixture generator
- Circuit analysis and synthesis: truth table generation, boolean expression extraction, Quine-McCluskey minimization, Karnaugh map visualization, expression editor, circuit synthesis, expression modifiers (NAND-only, NOR-only, N-input), path analysis, dependency analysis, statistics, cycle detection
- Finite state machine editor: graphical FSM design, FSM-to-transition-table, FSM-to-circuit synthesis
- Export: SVG (with LaTeX), PNG, animated GIF, ZIP archive, truth table formats (CSV, Hex, LaTeX)
- Tutorial integration: iframe embedding with postMessage API
- Application features: localization (7 languages), 74xx IC library, color scheme editor, settings persistence, remote control interface

## Non-Goals

- VHDL/Verilog export or co-simulation
- JEDEC/CUPL export for programmable logic devices
- FPGA programming (BASYS3, TinyFPGA)
- MNA analog simulation engine (stays in GWT; the engine-agnostic editor enables future integration without forking editor code)
- Gate-level memory modeling (SRAM/Flash must be behavioral — `Uint8Array`/`Uint16Array` lookup tables, not individual flip-flop cells)
- Telnet component (requires TCP server socket, impossible in browser)
- Java plugin/JAR component loading
- Server-side anything — output is purely static files
- Replicating Digital's Swing UI pixel-for-pixel

## Performance Architecture

The simulator must handle gate-level 8-bit MCU circuits (~15,000–25,000 gates, ~600 flip-flops with behavioral memory). A naive event-driven JS simulator hits real-time limits at ~5,000–10,000 actively-switching gates. These architectural constraints must be designed into Phase 1 and Phase 3 foundations — they cannot be retrofitted.

### Dual Signal Representation

Signal state has two forms:
- **OOP API** (`BitVector` class): for UI, property panels, serialization. Allocating, ergonomic.
- **Flat typed arrays** (`Uint32Array` indexed by net ID): for the engine hot path. Zero-allocation, high-throughput.

The engine interface exposes both: `getSignalValue(netId): BitVector` (allocating, for UI) and `getSignalRaw(netId): number` (non-allocating, for engine internals and rendering).

### Levelized Compiled Evaluation (Default Engine Mode)

The primary simulation mode is **levelized compiled evaluation**, ported from Digital's `ModelCreator`:
1. At circuit compile time, topologically sort all combinational gates
2. Separate sequential elements (flip-flops) from combinational logic
3. On each clock edge: evaluate all flip-flops (sample inputs), then evaluate the sorted combinational array in a flat `for` loop
4. No event queue for steady-state simulation

Event-driven propagation is the **secondary mode**, used for micro-step teaching and timing analysis.

### Zero-Allocation Inner Loop

The simulation hot path must allocate zero JavaScript objects:
- Event pool: pre-allocated ring buffer, reuse slots (event-driven mode only)
- Signal state: flat `Uint32Array`, not `BitVector` objects
- Listener arrays: flat function reference arrays, no closures
- Component state: flat typed arrays indexed by component ID

### Web Worker Compatibility

The engine interface must be Web Worker-compatible from day one:
- No DOM references in engine state
- Signal state in `SharedArrayBuffer` (main thread reads for rendering via `Atomics`)
- Control messages (start/stop/step) via `postMessage`
- Graceful fallback to main-thread simulation if `Cross-Origin-Isolation` headers are unavailable

### Monomorphic Dispatch

Component evaluations grouped by type at compile time. Function table indexed by type ID — each call site sees one function. V8 can inline and optimize. Avoids megamorphic penalty from ~110 component types flowing through a single `execute()` call site.

## Verification

- **Phase 0**: No CheerpJ artifacts remain. `git status` shows only removals and modified `CLAUDE.md`.
- **Phase 1**: `tsc --noEmit` passes. Vitest runs. Mock contexts work. `vite build` produces static output. Dual signal representation round-trips correctly. Error types are well-formed.
- **Phase 2**: SimulatorFacade builds circuits headlessly — builder smoke tests pass in Node.js (no browser). Browser-dep fence lint rule catches violations. Automated tests for all interaction modes. Bus annotations display mock values. Search finds elements. Label tools rename correctly. Color schemes switch rendering. Locked mode prevents editing.
- **Phase 3**: Levelized evaluation matches event-driven results for all test circuits. Noise mode resolves RS flip-flop startup without oscillation. Bus resolution detects shorted outputs (BurnException). Micro-step advances one gate. Run-to-break halts at Break component. Quick-run completes without rendering. Web Worker mode produces identical results to main-thread mode. **Headless runner**: `facade.compile()` + `facade.step()` + `facade.readOutput()` produces correct results for `and-gate.dig`, `half-adder.dig`, `sr-latch.dig` checkpoint circuits.
- **Phase 4**: Parser reads all tutorial .dig files. Attribute mapping framework works. InverterConfig applies correctly. HGS interpreter passes ported ParserTest suite. JSON round-trip is lossless. **Headless .dig loading**: `facade.loadDig(path)` loads checkpoint circuits in Node.js without a browser.
- **Phase 5**: Each component has unit tests for logic and rendering. All ~110 types registered with .dig attribute mappings. Display components produce output to their display interfaces. Tunnel components share signal by name. Each component can be instantiated via `facade.addComponent()`, compiled, and exercised headlessly.
- **Phase 6**: End-to-end .dig load → compile → simulate works both headlessly (via facade) and in browser (via editor binding). `facade.runTests()` passes for all checkpoint circuits. Generic circuit resolution produces correct concrete circuits (verified against Digital's output). Engine-editor binding updates canvas live. postMessage adapter works with tutorial host.
- **Phase 7**: Data table shows live values. Timing diagram records signals. Wire tooltips show values on hover. Memory editor views/edits RAM contents during simulation. Test case editor creates and runs new tests. Hex/Logisim/binary file loads into memory components.
- **Phase 8**: Analyze circuit produces correct truth table. Expression minimization matches known results. Karnaugh map highlights prime implicants. Synthesis generates working circuit from truth table. Expression modifiers produce NAND-only/NOR-only circuits. Cycle detector identifies feedback loops.
- **Phase 9**: SVG export produces valid SVG. PNG renders at correct resolution. Settings persist across sessions. i18n strings switch correctly. 74xx library circuits load as subcircuits. Truth table exports to CSV/LaTeX.
- **Phase 10**: FSM editor draws states/transitions. FSM→table produces correct state transition table. FSM→circuit generates working sequential circuit.
- **Phase 11**: Repository-wide search for removed artifact names returns zero results.

## Dependency Graph

```
Phase 0 (Dead Code Removal)                         ─── runs first, alone
│
Phase 1 (Foundation & Types)                         ─── after 0
├──→ Phase 2 (Canvas Editor)             ─── parallel after 1 ──┐
├──→ Phase 3 (Simulation Engine)         ─── parallel after 1    │
├──→ Phase 4 (.dig Parser, File IO, HGS) ─── parallel after 1    │
├──→ Phase 5 (Component Library)         ─── parallel after 1    │
│                                                                 │
│    Phase 6 (Core Integration)          ─── after 2+3+4+5 ──────┘
│    ├──→ Phase 7 (Runtime Tools)        ─── parallel after 6 ──┐
│    ├──→ Phase 8 (Analysis & Synthesis) ─── parallel after 6    │
│    ├──→ Phase 9 (Export & Application) ─── parallel after 6    │
│    │                                                            │
│    │    Phase 10 (FSM Editor)          ─── after 8 ─────────────┘
│
Phase 11 (Legacy Reference Review)                   ─── runs last, after all
```

Phases 2–5 are fully independent, all parallel after Phase 1.
Phases 7–9 are fully independent, all parallel after Phase 6.
Phase 10 (FSM) depends on Phase 8 (Analysis) for FSM→circuit synthesis.

---

## Phase 0: Dead Code Removal
**Depends on**: (none — runs first)

Remove the CheerpJ prototype stack so the repository is clean for the native TS port. `PLANNING.md`, `tutorial.html`, and `tutorial.json` were already deleted prior to this phase.

### Wave 0.1: Remove CheerpJ Stack
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 0.1.1 | Remove remaining CheerpJ artifacts: `Digital.jar`, `digital.html`, `bridge.html`, `test-bridge.html`, `xstream-shim.jar`, `xstream-patch/` (entire directory), `jdk-shim/` (entire directory), `stack-question-template.txt`. Rewrite `CLAUDE.md` to reflect post-deletion repo state (no CheerpJ references, point to `spec/plan.md`). | M | Digital.jar, digital.html, bridge.html, test-bridge.html, xstream-shim.jar, xstream-patch/\*, jdk-shim/\*, CLAUDE.md |

---

## Phase 1: Foundation & Type System
**Depends on**: Phase 0
**CHECKPOINT**: Author review required after completion. Phases 2–5 are blocked until the author approves the interfaces. See `spec/author_instructions.md` § Checkpoint 1.

Complete type system, interface contracts, error taxonomy, and project infrastructure. Every interface defined here is the contract that Phases 2–10 implement against. Performance architecture (dual signal representation, Worker-compatible engine interface) must be baked in here.

### Wave 1.1: Project Infrastructure
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.1.1 | TypeScript project setup: `package.json`, `tsconfig.json` (strict mode), Vite config, directory structure (`src/core/`, `src/editor/`, `src/engine/`, `src/components/`, `src/io/`, `src/hgs/`, `src/testing/`, `src/analysis/`, `src/fsm/`), ESLint, `.gitignore`, Zod dependency | M | package.json, tsconfig.json, vite.config.ts |
| 1.1.2 | Test infrastructure: Vitest config, mock `RenderContext` (records draw calls), mock engine (tracks signal state), dev workflow (Vite dev → simulator.html → tutorial host iframe), build verification script | M | vitest.config.ts, src/test-utils/\* |

### Wave 1.2: Core Type System
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.2.1 | Signal value types: `Bit` enum (ZERO, ONE, HIGH_Z, UNDEFINED), `BitVector` class (arbitrary-width multi-bit, OOP API for UI), signal arithmetic, comparison, number conversion, configurable display radix (bin/hex/dec/signed). **Also**: `SignalState` flat typed-array representation (`Uint32Array` indexed by net ID) for the engine hot path, with conversion functions between `BitVector` ↔ raw. | M | src/core/signal.ts |
| 1.2.2 | Pin system: `Pin` interface (direction, position, label, bit width, clock marker, negation bubble), `PinDirection` enum, N/S/E/W layout placement, connection state, `InverterConfig` (per-pin inversion bubbles, stored in .dig files) | M | src/core/pin.ts |
| 1.2.3 | Component property system: `PropertyDefinition`, `PropertyBag`, property types (INT, STRING, ENUM, BOOLEAN, BIT_WIDTH, HEX_DATA, COLOR), Zod schemas for serialization boundaries | M | src/core/properties.ts |

### Wave 1.3: Interface Contracts
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.3.1 | `CircuitElement` interface: identity, type ID (string, matches registry name), pin declarations, property declarations, bounding box, rotation/mirror. Rendering: `draw(ctx: RenderContext)`. Serialization: `serialize()`. Help text declaration. HGS-compatible attribute access (map-like interface for generic resolution). **No `execute()` method** — simulation logic lives in standalone flat functions per Decision 1. | L | src/core/element.ts |
| 1.3.2 | Engine interface: pluggable simulation contract — `init`, `start`, `stop`, `step`, `microStep`, `runToBreak`, `reset`, `getSignalValue(netId): BitVector`, `getSignalRaw(netId): number`, `setSignalValue`, `addChangeListener`. `EngineState` enum. `SimulationEvent` type. Measurement observation interface. **Must be Web Worker-compatible**: no DOM references, signal state backed by `SharedArrayBuffer`-compatible typed arrays, control via message-passable commands. | L | src/core/engine-interface.ts |
| 1.3.3 | Renderer interface: drawing context abstraction — lines, rects, polygons, arcs, text, paths, fill/stroke. Style state (color, lineWidth, font). Coordinate types (Point, Rect, Transform). Color scheme interface (theme-switchable colors). | L | src/core/renderer-interface.ts |
| 1.3.4 | Circuit model: `Circuit` class (elements + nets), `Net` class (connected pins), `Wire` class (visual segments), component registry (type name → constructor + numeric type ID). Measurement ordering (which signals to observe, in what order). | L | src/core/circuit.ts, src/core/registry.ts |
| 1.3.5 | Error type taxonomy: port Digital's exception hierarchy. `SimulationError` base. `BurnException` (shorted outputs / conflicting drivers on a net), `BacktrackException` (switching network initialization failure), `BitsException` (bit-width mismatch), `NodeException` (component evaluation error), `PinException` (unconnected/misconfigured pin). Each carries source component and net context for user-facing diagnostics. | M | src/core/errors.ts |

---

## Phase 2: Canvas Editor
**Depends on**: Phase 1
**Parallel with**: Phase 3, Phase 4, Phase 5
**CHECKPOINT**: Author must provide UI layout wireframe before Wave 2.4 begins. Waves 2.1–2.3 can proceed without it. See `spec/author_instructions.md` § Checkpoint 3.

The complete interactive circuit editor with all of Digital's editing features. SimulatorFacade composed from modules (builder, runner, loader, tester). Clone Digital's UI layout — tree palette left, property panel right, toolbar top, all collapsible for iframe embedding. See `spec/phase-2-canvas-editor.md` for the full spec.

### Wave 2.0: Headless Simulator Facade
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.0.1 | **SimulatorFacade interface**: Define the headless API contract — the single programmatic surface for AI agents and the postMessage bridge. `createCircuit(opts?)` → `CircuitHandle`. `addComponent(circuit, typeName, props?)` → `ComponentHandle`. `connect(circuit, srcHandle, srcPin, dstHandle, dstPin)`. `compile(circuit)` → `EngineHandle`. `step(engine)`, `run(engine, cycles)`, `runToStable(engine, maxIterations?)`. `setInput(engine, label, value)`, `readOutput(engine, label)` → `BitVector`. `readAllSignals(engine)` → `Map<string, BitVector>`. `runTests(engine)` → `TestResults`. `loadDig(pathOrXml)` → `CircuitHandle`. `serialize(circuit)` → JSON string. Handles are opaque — the facade manages the mapping to real `Circuit`, `CompiledCircuit`, and `SimulationEngine` instances. Also re-export all low-level core types (`BitVector`, `Circuit`, `Net`, `Wire`, `Pin`, `PropertyBag`, `ComponentRegistry`, `SimulationEngine`, error types) for agents that need direct access. | M | src/headless/facade.ts, src/headless/types.ts, src/headless/index.ts |
| 2.0.2 | **Circuit builder implementation**: Implement `createCircuit`, `addComponent`, `connect` portion of the facade. `addComponent` looks up `ComponentDefinition` in the registry, calls `factory(props)`, auto-assigns grid-snapped position (auto-layout by insertion order, or caller-specified via optional `position` property), adds to `Circuit`, returns handle. `connect` resolves pin labels on source/destination components to `Pin` instances, creates `Wire` segments between pin world-space positions. Validates: unknown component type → clear error naming the type, unknown pin label → clear error naming the label and listing valid pins, bit-width mismatch → `BitsException`. Zero browser dependencies — pure Node.js compatible. | M | src/headless/builder.ts |
| 2.0.3 | **Headless entry point and browser-dep fence**: Create `src/headless/index.ts` that re-exports facade, builder, and all core types. Add ESLint rule (`no-restricted-globals` or custom rule) enforcing that files under `src/headless/`, `src/core/`, `src/engine/`, `src/io/`, and `src/testing/` cannot import from `src/editor/` or reference DOM globals (`window`, `document`, `HTMLCanvasElement`, `CanvasRenderingContext2D`). This fence is enforced at lint/CI time — violations fail the build. | S | src/headless/index.ts, eslint.config.js |
| 2.0.4 | **Builder smoke tests**: Vitest tests exercising the circuit builder in Node.js (no browser). Create a half-adder programmatically: add `In`, `Out`, `And`, `XOr` components, connect pins, verify `Circuit` model has correct elements/wires/pin connections. Verify error cases: unknown component type, unknown pin label, duplicate connection, bit-width mismatch. Verify the browser-dep fence: attempt to import `src/editor/` from `src/headless/` → lint error. | M | src/headless/\_\_tests\_\_/builder.test.ts |

### Wave 2.1: Canvas Foundation
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.1.1 | Canvas 2D renderer: implement renderer interface using Canvas 2D API. All drawing primitives. Transform stack for rotation/mirroring. Color scheme support (render all colors through theme indirection). | M | src/editor/canvas-renderer.ts |
| 2.1.2 | Coordinate system & grid: world ↔ screen transforms, grid rendering (major/minor lines), grid snapping, configurable grid size, snap-to-grid toggle (on/off setting) | M | src/editor/grid.ts, src/editor/coordinates.ts |
| 2.1.3 | Pan & zoom: mouse wheel zoom (centered on cursor), middle-click/space+drag pan, zoom limits, viewport management, fit-to-circuit, zoom percentage presets (100%, 150%, 200%, etc. in menu) | M | src/editor/viewport.ts |

### Wave 2.2: Element & Wire Rendering
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.2.1 | Component rendering dispatch: iterate elements, apply transforms, call `element.draw(ctx)`, pin indicators, selection highlighting | M | src/editor/element-renderer.ts |
| 2.2.2 | Wire rendering: Manhattan segments, junction dot auto-placement (port Digital's `DotCreator` — detect wire crossings/joins and place dots), bus wires (thicker for multi-bit), wire color by signal state, bus value annotations (display multi-bit values as hex/dec labels on bus wires, configurable radix), wire tooltip on hover (show current signal value), selection highlighting | L | src/editor/wire-renderer.ts |

### Wave 2.3: Interaction Model
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.3.1 | Hit-testing: point-in-element, point-near-wire, point-on-pin, priority ordering, rectangular region intersection | L | src/editor/hit-test.ts |
| 2.3.2 | Selection model: click, shift-click, box-select, Ctrl+A, Escape, selection management | M | src/editor/selection.ts |
| 2.3.3 | Placement mode: palette ghost, grid snap, click-to-place, R to rotate, M to mirror, Escape to cancel | M | src/editor/placement.ts |
| 2.3.4 | Wire drawing mode: click output pin → Manhattan routing → waypoints → click input pin. Visual preview. Escape cancel. Wire consistency checking (port `WireConsistencyChecker`). Wire merging for collinear segments (port `WireMerger`). | L | src/editor/wire-drawing.ts |

### Wave 2.4: Core Edit Operations
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.4.1 | Move, copy, paste, delete: drag with grid snap, Ctrl+C/V/X, Delete, duplicate (Ctrl+D). Copy label renaming — auto-increment numeric suffixes when copying components (e.g., `Reg1` → `Reg2`, port `CopiedElementLabelRenamer`). | M | src/editor/edit-operations.ts |
| 2.4.2 | Undo/redo: command pattern for all operations. Ctrl+Z / Ctrl+Shift+Z. Configurable stack depth. | L | src/editor/undo-redo.ts |
| 2.4.3 | Component palette: categorized list (Logic, I/O, Flip-Flops, Memory, Arithmetic, Wiring, Switching, PLD, Misc, 74xx). Search/filter. Click to place. Collapsible categories. Insert history (recently placed). Optional tree view alternative (`SelectTree`-style hierarchical browser). | M | src/editor/palette.ts |
| 2.4.4 | Property editor panel: type-appropriate inputs (number, text, enum, boolean, hex data, color). Immediate apply. Undo integration. | M | src/editor/property-panel.ts |
| 2.4.5 | Context menus & keyboard shortcuts: right-click menu, configurable shortcut map, default bindings | M | src/editor/context-menu.ts, src/editor/shortcuts.ts |

### Wave 2.5: Extended Editor Features
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.5.1 | Find/search (Ctrl+F): search for components and labels in circuit, highlight matches, navigate between results | S | src/editor/search.ts |
| 2.5.2 | Label tools: numbering wizard (auto-number component labels), add/remove label prefix (batch), auto-label pins, reorder input/output pin ordering, remove pin numbers, tunnel rename dialog (auto-rename when copying tunnels) | M | src/editor/label-tools.ts |
| 2.5.3 | Insert selection as new subcircuit: convert selected components+wires into a subcircuit, auto-create interface pins from cut wires | L | src/editor/insert-subcircuit.ts |
| 2.5.4 | Auto power supply: scan circuit for unconnected power pins, auto-add VDD/GND connections | S | src/editor/auto-power.ts |
| 2.5.5 | Element help dialog: right-click any component → show documentation (description, pin table, behavior, truth table where applicable). Content from component help text declarations. | M | src/editor/element-help.ts |
| 2.5.6 | Presentation mode (F4): fullscreen canvas, simplified toolbar, hidden palette/property panel, enlarged components for projection | M | src/editor/presentation.ts |
| 2.5.7 | Color scheme framework: built-in schemes (default, high contrast, monochrome), color scheme editor (customize colors), apply scheme to all rendering. IEEE vs DIN/IEC gate shape toggle (global setting, affects all gate rendering). | M | src/editor/color-scheme.ts |
| 2.5.8 | Settings dialog: application preferences (grid size, default gate delay, color scheme, language, simulation speed, radix default, gate shape style IEEE/DIN, snap-to-grid). Persist to localStorage. | M | src/editor/settings.ts |
| 2.5.9 | File history: recent files list in File menu, persist to localStorage. | S | src/editor/file-history.ts |
| 2.5.10 | Locked mode: prevent circuit modification — simulation-only interaction. Users can toggle switches, click buttons, and observe outputs but cannot add/move/delete components or wires. Essential for distributing tutorial circuits to students. | M | src/editor/locked-mode.ts |
| 2.5.11 | Actual-to-default: capture current simulation runtime values and save them as the circuit's default component property values. Restore all fuses (reset all blown fuses in the circuit). | S | src/editor/runtime-to-defaults.ts |

---

## Phase 3: Simulation Engine
**Depends on**: Phase 1
**Parallel with**: Phase 2, Phase 4, Phase 5

One simulation engine with three evaluation modes (level-by-level, timed, micro-step) sharing the same flat `Uint32Array` signal storage. SCC-based compilation handles combinational feedback (SR latches from gates). See `spec/phase-3-simulation-engine.md` for the full spec.

### Wave 3.1: Core Engine
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.1.1 | Single engine implementation with three evaluation modes: (1) **Level-by-level** (default) — SCC-aware topological sweep, one pass for non-feedback gates, iterate on feedback SCCs until stable. (2) **Timed** — per-component propagation delays, timing wheel event queue, glitch-visible. (3) **Micro-step** — one gate per step, reports which component fired. All modes share flat `Uint32Array` signal state, same compiled wiring tables, same function table. Zero allocation in level-by-level inner loop. | L | src/engine/digital-engine.ts |
| 3.1.2 | Timing wheel event queue: O(1) amortized circular-buffer queue indexed by timestamp modulo wheel size. Pre-allocated event pool (zero allocation). Same-net replacement (latest schedule wins). For timed evaluation mode. | L | src/engine/timing-wheel.ts, src/engine/event-pool.ts |
| 3.1.3 | Noise mode and initialization: port Digital's init sequence. Noise mode shuffles evaluation order within feedback SCCs and interleaves reads/writes to break symmetry. Reset component protocol (held low during init, released after). Synchronized (non-noise) mode snapshots SCC inputs for order-independent evaluation. | M | src/engine/noise-mode.ts, src/engine/init-sequence.ts |

### Wave 3.2: Circuit Compilation & Net Resolution
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.2.1 | Circuit compiler: visual Circuit → executable graph. Pipeline: enumerate components → trace nets (3.2.2) → build wiring tables (ComponentLayout) → SCC decomposition via Tarjan's algorithm → topological sort of condensation DAG → build function table (executeFns indexed by type ID) → allocate signal arrays (Uint32Array for values + highZ) → pre-allocate SCC snapshot buffer → classify sequential elements → produce `CompiledCircuit` with `evaluationOrder: EvaluationGroup[]` where each group is `{ componentIndices: Uint32Array; isFeedback: boolean }`. Also produces `labelToNetId` (for facade label-based access) and `wireToNetId` (for renderer wire coloring). | L | src/engine/compiler.ts, src/engine/compiled-circuit.ts, src/engine/tarjan.ts, src/engine/topological-sort.ts |
| 3.2.2 | Net resolution: trace wire connections to nets by matching endpoints to pin positions and wire-to-wire junctions. Union-Find for efficient merging. Tunnel name-matching (same label = same net). Validate bit-width consistency within nets (`BitsException` on mismatch). Classify nets: single-driver vs multi-driver (→ bus resolution). Detect unconnected input pins (warning, not error). Returns `NetResolution` with typed `ResolvedNet[]`. | M | src/engine/net-resolver.ts |
| 3.2.3 | Bus resolution subsystem: port Digital's `core/wiring/bus/`. Resolve multi-driver nets: high-Z only if ALL drivers assert high-Z (AND of masks), value = OR of non-high-Z drivers, burn detection if non-high-Z drivers disagree. Burn is deferred to post-step (transient conflicts tolerated). Pull-up/pull-down resolves floating bits. Switch-driven net merging: close → merge two bus nets, open → split. Runtime-dynamic reconfiguration. | L | src/engine/bus-resolution.ts |

### Wave 3.3: Advanced Features
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.3.1 | Propagation delay model: per-component configurable gate delay for timed mode. `ComponentDefinition.defaultDelay` (default 10ns), overridable per instance via `delay` property. Compiler builds flat `Uint32Array` of delays indexed by component index. Resolution priority: instance property > definition default > global default (10ns). Modifies `src/core/registry.ts` to add `defaultDelay` to `ComponentDefinition`. | M | src/engine/delay.ts, src/core/registry.ts |
| 3.3.2 | Feedback & oscillation detection: runtime detection after configurable limit (default 1000 micro-steps). On limit: collect still-toggling components for 100 more steps to confirm pattern, then throw `NodeException` with oscillating component list. Compile-time warning when SCC decomposition finds feedback loops (informational, not error). | M | src/engine/oscillation.ts |
| 3.3.3 | Clock management: identify Clock components after compilation, manage clock edge toggling at configured frequencies, multi-clock domains with independent frequencies. On clock edge: evaluate sequential elements sampling on that edge, then sweep combinational. Real-time clock mode (wall-clock pacing for demos). `AsyncSequentialClock` mode for circuits with no explicit clock. | M | src/engine/clock.ts |

### Wave 3.4: Simulation Modes
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.4.1 | Standard controls: state machine (STOPPED → RUNNING → PAUSED → ERROR), step (full propagation cycle), continuous run (rAF-driven, configurable steps-per-frame), pause, reset. Error handler registration. | M | src/engine/controls.ts |
| 3.4.2 | Micro-step mode: advance one single component evaluation, update output nets, schedule affected downstream, stop. Reports which component was evaluated via `MicroStepResult { componentIndex, typeId, changedNets }`. For teaching signal propagation order. | M | src/engine/micro-step.ts |
| 3.4.3 | Run-to-break: run until a Break component fires (input asserted), then halt. Returns `BreakResult { reason: 'break' \| 'maxSteps', breakComponent?, stepsExecuted }`. Max steps safety limit. | M | src/engine/run-to-break.ts |
| 3.4.4 | Quick run: suppress all change listeners and measurement observers, run N steps in tight loop, restore listeners. Speed test benchmark mode (report steps/sec, kHz, matching Digital's `SpeedTest` metric). | S | src/engine/quick-run.ts |
| 3.4.5 | Web Worker mode: `WorkerEngine` proxy implementing `SimulationEngine`. Signal state in `SharedArrayBuffer`, main thread reads via `Atomics.load()`. Control messages via `postMessage`. `DigitalEngine` runs identically in both modes (reads/writes Uint32Array — only the backing buffer differs). Factory function: returns `WorkerEngine` if SAB available, else `DigitalEngine` on main thread. | L | src/engine/worker-engine.ts, src/engine/worker.ts, src/engine/worker-detection.ts |

### Wave 3.5: Headless Simulation Runner
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.5.1 | **Headless compile + run**: `SimulationRunner` module for the SimulatorFacade. `compile(circuit)` calls compiler (3.2.1) → `CompiledCircuit`, initializes `DigitalEngine` (level-by-level default), runs init sequence. `setInput(engine, label, value)` resolves via `compiledCircuit.labelToNetId`. `readOutput(engine, label)` resolves Out/Probe by label. `readAllSignals(engine)` → `Map<string, BitVector>`. `runToStable(engine, maxIterations=1000)` loops step until stable or throws `OscillationError`. No browser dependencies. | M | src/headless/runner.ts |
| 3.5.2 | **Signal trace capture**: `captureTrace(runner, engine, labels, steps)` → runs N steps, samples named signals after each, returns `Map<string, BitVector[]>`. For verifying sequential circuit timing (e.g., counter over N clock cycles). | S | src/headless/trace.ts |
| 3.5.3 | **Headless runner smoke tests**: Half-adder: build via circuit builder, compile, test all 4 input combinations. `runToStable` on combinational (stabilizes in 1 step). Signal trace on sequential circuit. Error: oscillating circuit throws `OscillationError`. | M | src/headless/\_\_tests\_\_/runner.test.ts |

---

## Phase 4: .dig Parser, File I/O & HGS
**Depends on**: Phase 1
**Parallel with**: Phase 2, Phase 3, Phase 5

Parse Digital's .dig XML format with XStream reference resolution, attribute mapping to PropertyBag, HGS scripting for parameterized circuits, hex file import (Intel HEX, Logisim raw, binary), and native JSON save/load. HGS evaluator is async to support browser file I/O. See `spec/phase-4-dig-parser.md` for the full spec.

### Wave 4.1: .dig XML Parser
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 4.1.1 | .dig XML schema types: TypeScript types for the complete .dig parse tree. Discriminated union `DigValue` covering all attribute value types (string, int, long→bigint, boolean, rotation, awt-color, testData, inverterConfig, data, inValue, romList, enum). | M | src/io/dig-schema.ts |
| 4.1.2 | .dig XML parser: DOMParser-based (browser native or `@xmldom/xmldom` for Node.js). XStream reference resolution (XPath-like traversal for shared objects). Version migration (0→1 doubles coordinates, 1→2 updates ROM format). Extracts visual elements, wires, measurement ordering, all typed attribute values. | L | src/io/dig-parser.ts, src/io/dom-parser.ts |

### Wave 4.2: Attribute Mapping & Circuit Construction
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 4.2.1 | Attribute mapping framework: reusable converter functions (stringConverter, intConverter, bigintConverter, boolConverter, rotationConverter, inverterConfigConverter, colorConverter, testDataConverter, dataFieldConverter, inValueConverter, enumConverter). Unmapped attributes preserved in `_unmapped` field. Individual mappings registered by components in Phase 5. | M | src/io/attribute-map.ts |
| 4.2.2 | Circuit construction from parsed XML: look up `elementName` in registry, apply attribute mappings to produce PropertyBag, call factory, position element. Create wires. Apply InverterConfig (set `isNegated` on specified pins). Extract circuit metadata. Fail hard on unknown component types with diagnostic. | M | src/io/dig-loader.ts |

### Wave 4.3: HGS Interpreter
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 4.3.1 | HGS tokenizer: port `Tokenizer.java`. All token types including `:=` declaration, `=` assignment/equality, template delimiters (`<? ?>`), hex literals, string escapes, line number tracking. | M | src/hgs/tokenizer.ts |
| 4.3.2 | HGS parser: port `Parser.java`. Recursive descent, operator precedence climbing. AST nodes for all expressions and statements. Template mode (text + `<? ?>` code blocks). Line number tracking on all nodes. | L | src/hgs/parser.ts, src/hgs/ast.ts |
| 4.3.3 | HGS evaluator & runtime: **async** evaluator (`async/await` throughout). `bigint` for all integer operations. Scope chain with lexical scoping. ~25 built-in functions. `loadHex(filename, dataBits, bigEndian?)` and `loadFile(filename)` fully implemented via `FileResolver` interface (browser: pre-loaded file map from `<input type="file">`; Node.js: `fs.readFile`). Return via `ReturnValue` sentinel. | L | src/hgs/context.ts, src/hgs/value.ts, src/hgs/evaluator.ts, src/hgs/builtins.ts |
| 4.3.4 | HGS reference system: `ReferenceToVar`, `ReferenceToArray`, `ReferenceToStruct`, `ReferenceToFunc`. Composable l-value abstractions for chained access (`obj.field[i]`). All async. | M | src/hgs/refs.ts |
| 4.3.5 | File I/O and hex import: `FileResolver` interface with `NodeFileResolver` and `BrowserFileResolver`. `DataField` class for memory contents. Hex format importers: Logisim raw hex (with RLE), Intel HEX (with extended address records), raw binary (with endianness). DataField serialization for .dig `Data` attribute round-trip. | L | src/hgs/file-resolver.ts, src/io/data-field.ts, src/io/hex-import.ts |
| 4.3.6 | HGS test suite: port Digital's `ParserTest.java`. Variables, control flow, functions, closures, recursion, arrays, maps, template mode, built-in functions, error cases. Behavioral parity with Java. | M | src/hgs/\_\_tests\_\_/hgs-parity.test.ts |

### Wave 4.4: Native Save/Load Format
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 4.4.1 | JSON save: serialize Circuit to JSON. Elements with type name, properties, position, rotation. Wires with endpoints. Metadata. Format version 1. Stable key ordering. bigint serialized as `"_bigint:"` prefixed strings. | M | src/io/save.ts, src/io/save-schema.ts |
| 4.4.2 | JSON load: deserialize with Zod validation, format version checking, migration support. bigint restoration from `"_bigint:"` prefix. | M | src/io/load.ts |
| 4.4.3 | **Headless .dig loading**: `SimulationLoader` module for SimulatorFacade. `loadDig(pathOrXml)` — async, auto-detects XML string vs file path/URL. Browser: native `DOMParser` + `fetch()`. Node.js: `@xmldom/xmldom` (runtime dependency) + `fs.readFile()`. Chains: XML → parseDigXml → loadDigCircuit → Circuit. | M | src/headless/loader.ts |

### Wave 4.5: Generic Circuit Resolution
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 4.5.1 | HGS generic circuit resolution: port `ResolveGenerics.java`. Execute `GenericInitCode` to produce parameter context. Execute `generic` attribute code on components with `args` and `this` context. Execute `GenericCode` with `addComponent()`/`addWire()` circuit-building functions. Cache resolved circuits by argument hash. | L | src/io/resolve-generics.ts |

---

## Phase 5: Component Library
**Depends on**: Phase 1
**Parallel with**: Phase 2, Phase 3, Phase 4
**CHECKPOINT**: Task 5.1.1 (`And` gate) is the exemplar component. It must be implemented first and reviewed by the author before the remaining ~109 components begin. See `spec/author_instructions.md` § Checkpoint 2.

All ~110 component types. Each component: `CircuitElement` class (rendering via `RenderContext`, properties, serialization), standalone flat `executeFn` (simulation logic on `Uint32Array`), `.dig` attribute mapping registration, complete `ComponentDefinition` (including `defaultDelay`, `internalStateCount`, `backingStoreType`), unit tests with mock contexts. Stateful components use extra Uint32Array pseudo-net slots. RAM/ROM use `DataField` side-car. Interactive components use `engine.setSignalValue()`. All gates render both IEEE/US and IEC/DIN shapes. See `spec/phase-5-component-library.md` for the full spec.

### Wave 5.1: Foundation Components (validate interfaces, establish patterns)
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 5.1.1 | Standard logic gates: `And`, `Or`, `Not`, `NAnd`, `NOr`, `XOr`, `XNOr` — configurable 2-N inputs, US/IEEE + IEC/DIN shapes (both, toggled by global setting), truth table logic. Template-setting implementations. | L | src/components/gates/\*.ts |
| 5.1.2 | Basic I/O: `In` (interactive toggle), `Out` (display value with configurable radix), `Clock` (configurable frequency), `Const`, `Ground`, `VDD`, `NotConnected` | M | src/components/io/basic.ts |
| 5.1.3 | Drivers & basic wiring: `Driver`, `DriverInvSel`, `Splitter`, `BusSplitter` | M | src/components/wiring/splitter.ts |
| 5.1.4 | Tunnel: named wire connections — two Tunnels with the same name in the same circuit are electrically connected regardless of position. Replaces long wires. Tunnel rename dialog on copy. Essential for .dig compatibility (Digital uses Tunnels heavily). | M | src/components/wiring/tunnel.ts |

### Wave 5.2: All Remaining Standard Components (parallel batches)
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 5.2.1 | MUX & routing: `Multiplexer`, `Demultiplexer`, `Decoder`, `BitSelector`, `PriorityEncoder` | M | src/components/wiring/mux.ts |
| 5.2.2 | Simulation control: `Delay`, `Break`, `Stop`, `Reset`, `AsyncSeq` | S | src/components/wiring/control.ts |
| 5.2.3 | Flip-flops: `FlipflopD`, `FlipflopDAsync`, `FlipflopJK`, `FlipflopJKAsync`, `FlipflopRS`, `FlipflopRSAsync`, `FlipflopT` | M | src/components/flipflops/\*.ts |
| 5.2.4 | Monoflop: monostable multivibrator | S | src/components/flipflops/monoflop.ts |
| 5.2.5 | Basic arithmetic: `Add`, `Sub`, `Mul`, `Div` — configurable width, carry/overflow | M | src/components/arithmetic/basic.ts |
| 5.2.6 | Arithmetic utilities: `Neg`, `Comparator`, `BarrelShifter`, `BitCount`, `BitExtender`, `PRNG` | M | src/components/arithmetic/util.ts |
| 5.2.7 | Counters: `Counter` (configurable bits/modulus/direction), `CounterPreset` | M | src/components/memory/counter.ts |
| 5.2.8 | Registers: `Register`, `RegisterFile` | M | src/components/memory/register.ts |
| 5.2.9 | RAM: `RAMSinglePort`, `RAMSinglePortSel`, `RAMDualPort`, `RAMDualAccess`, `RAMAsync`, `BlockRAMDualPort` — configurable address/data width, hex initialization, behavioral `Uint8Array` backing store. Expose memory contents interface for live viewer (Phase 7). ROM manager for shared ROM data across instances. Auto-reload ROM option. | L | src/components/memory/ram.ts |
| 5.2.10 | ROM & EEPROM: `ROM`, `ROMDualPort`, `EEPROM`, `EEPROMDualPort` — hex data, address/data config, behavioral backing store, preload program option | M | src/components/memory/rom.ts |
| 5.2.11 | Specialty memory: `LookUpTable`, `ProgramCounter`, `ProgramMemory` | M | src/components/memory/special.ts |
| 5.2.12 | Switches: `Switch`, `SwitchDT`, `PlainSwitch`, `PlainSwitchDT` — interactive toggle, SPST/SPDT | M | src/components/switching/switch.ts |
| 5.2.13 | Relays: `Relay`, `RelayDT` — coil-controlled contacts, SPST/SPDT | M | src/components/switching/relay.ts |
| 5.2.14 | FETs & transmission gate: `NFET`, `PFET`, `FGNFET`, `FGPFET`, `TransGate` | M | src/components/switching/fet.ts |
| 5.2.15 | Fuse: one-time, irreversible | S | src/components/switching/fuse.ts |
| 5.2.16 | PLD: `Diode`, `DiodeBackward`, `DiodeForward`, `PullUp`, `PullDown` | S | src/components/pld/\*.ts |
| 5.2.17 | Interactive I/O: `Button`, `ButtonLED`, `DipSwitch`, `Probe` (measurement source with configurable radix), `PowerSupply` | M | src/components/io/interactive.ts |
| 5.2.18 | Visual indicators: `LED` (configurable color), `PolarityAwareLED` (considers anode/cathode orientation), `LightBulb`, `RGBLED` | M | src/components/io/indicators.ts |
| 5.2.19 | Segment displays: `SevenSeg`, `SevenSegHex`, `SixteenSeg` | M | src/components/io/display.ts |
| 5.2.20 | Oscilloscope: `Scope` — multi-channel waveform recording, time scale, trigger, channel labels. `ScopeTrigger` — separate placeable trigger component. | L | src/components/io/scope.ts |
| 5.2.21 | Rotary encoder & motors: `RotEncoder`, `StepperMotorBipolar`, `StepperMotorUnipolar` | M | src/components/io/electromechanical.ts |
| 5.2.22 | MIDI: `MIDI` — note on/off, channel, velocity. Web MIDI API. | M | src/components/io/midi.ts |
| 5.2.23 | Function: generic boolean function from truth table, truth table editor | M | src/components/basic/function.ts |
| 5.2.24 | Text & Rectangle annotations: `Text` — non-functional label, configurable font/style. `Rectangle` — visual decoration box for grouping components on canvas. Neither participates in simulation. | S | src/components/misc/annotations.ts |
| 5.2.25 | LED Matrix: `LedMatrix` — NxN LED grid display. Separate display panel/dialog showing the matrix output updating during simulation. | M | src/components/graphics/led-matrix.ts |
| 5.2.26 | VGA display: `VGA` — VGA-resolution pixel display component. Display panel showing framebuffer contents. | L | src/components/graphics/vga.ts |
| 5.2.27 | Graphic card: `GraphicCard` — graphics framebuffer with drawing commands. Display panel. | L | src/components/graphics/graphic-card.ts |
| 5.2.28 | Terminal & Keyboard: `Terminal` — serial text terminal (character display + keyboard input). Terminal panel with scrollback. `Keyboard` — keyboard input component. Keyboard dialog for input. | M | src/components/terminal/terminal.ts, src/components/terminal/keyboard.ts |
| 5.2.29 | Testcase element: `Testcase` — placeable test case component on the circuit canvas. Contains embedded truth table test data. Displayed as a labeled box. Test data accessible to test executor (Phase 6). | S | src/components/misc/testcase.ts |
| 5.2.30 | Data embedded view: `Data` — placeable inline waveform/data view on the circuit canvas. Shows live signal data directly on the canvas during simulation (distinct from the data table dialog in Phase 7). | M | src/components/misc/data-view.ts |

### Wave 5.3: Custom Shape System
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 5.3.1 | Custom shape rendering: SVG-based shape descriptions, parse SVG, map to canvas draw calls, pin anchor points, label positions. `CustomShape` component type. Serialization. | L | src/components/custom/custom-shape.ts |
| 5.3.2 | Custom shape editor: drawing tools (line, rect, ellipse, arc, text), pin placement, preview, save/load definitions | L | src/editor/shape-editor.ts |

---

## Phase 6: Core Integration
**Depends on**: Phase 2 + Phase 3 + Phase 4 + Phase 5

Wire all subsystems together into a working simulator.

### Wave 6.1: Subsystem Wiring
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.1.1 | Connect .dig parser to component registry: wire parser + attribute mappings to populated registry. Load .dig files end-to-end. Verify `and-gate.dig`, `half-adder.dig`, `sr-latch.dig`. | M | src/io/dig-loader.ts |
| 6.1.2 | Engine-editor binding: connect real engine to real editor through Phase 1 interfaces. State changes trigger redraws. Wire colors show live values (read from `getSignalRaw` for performance). Interactive components respond during simulation. | M | src/integration/editor-binding.ts |

### Wave 6.2: Subcircuit Support
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.2.1 | Subcircuit component type: rectangular chip rendering with interface pins, pin mapping, property editing. Multiple shape types: DEFAULT (box), CUSTOM (SVG), DIL (DIP package), LAYOUT. Port `CustomCircuitShapeType`. | M | src/components/subcircuit/subcircuit.ts |
| 6.2.2 | Recursive .dig loading: load subcircuit definitions recursively, cache loaded definitions, detect circular references (max depth = 30, matching Digital), nested subcircuits | L | src/io/subcircuit-loader.ts |
| 6.2.3 | Subcircuit engine flattening: inline into parent simulation graph, map interface pins, scoped naming, multiple instances, nested flattening | L | src/engine/flatten.ts |
| 6.2.4 | Generic circuit resolution: port Digital's `ResolveGenerics`. When a .dig file is marked `isGeneric=true`: deep-copy the circuit, create HGS context with `args` (parent parameters), `this` (element attributes), `addWire()`, `addComponent()`, `setCircuit()`, `global`, `settings`. Run `GenericInitCode` scripts for defaults, run per-element `generic` attribute scripts. Produce a concrete (non-generic) circuit. Cache resolved circuits by parameter values. | L | src/io/resolve-generics.ts |

### Wave 6.3: Test Execution
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.3.1 | Truth table parser: parse Digital's test syntax from .dig files (embedded in `Testcase` components) — signal names, input/output values, don't-care, clock directives, repeat/loop, comments | M | src/testing/parser.ts |
| 6.3.2 | Test executor: drive inputs per vector, run to stable, compare outputs, collect pass/fail per vector | M | src/testing/executor.ts |
| 6.3.3 | Test results display: table with pass/fail, highlight mismatches, summary, run/re-run | M | src/testing/results-ui.ts |
| 6.3.4 | **Headless test runner**: Implement `runTests(engine)` in the SimulatorFacade. Finds all `Testcase` components in the source circuit, parses their embedded test data (via 6.3.1 truth table parser), executes test vectors (via 6.3.2 test executor), returns structured `TestResults`: `{ passed: number, failed: number, total: number, vectors: { inputs: Record<string, string>, expectedOutputs: Record<string, string>, actualOutputs: Record<string, string>, pass: boolean }[] }`. Runnable from Node.js — no browser deps. Full integration test: `facade.loadDig('circuits/half-adder.dig')` → `facade.compile()` → `facade.runTests()` → all vectors pass. | M | src/headless/test-runner.ts, src/headless/\_\_tests\_\_/test-runner.test.ts |

### Wave 6.4: Tutorial Integration
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.4.1 | Simulator HTML page: standalone page with canvas, palette, property panel, toolbar (file ops, sim controls, test runner). Responsive layout. Works standalone and in iframe. | M | simulator.html, src/main.ts |
| 6.4.2 | postMessage API: receive `digital-load-url` / `digital-load-data`, send `digital-ready` / `digital-loaded` / `digital-error` | M | src/io/postmessage.ts |
| 6.4.3 | Tutorial host page: new tutorial host page with split-pane layout (instructions + live sim iframe). Point iframe to new simulator. URL params for tutorial selection and step navigation. | M | tutorial.html |

---

## Phase 7: Runtime Tools
**Depends on**: Phase 6
**Parallel with**: Phase 8, Phase 9

Data visualization, memory inspection, and test authoring — the tools that make the simulator usable for teaching.

### Wave 7.1: Data Visualization
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.1.1 | Data table panel: live tabular view of all measured signals (probes + ordered inputs/outputs). Updates during simulation. Columns: signal name, current value. Configurable radix per signal. | M | src/runtime/data-table.ts |
| 7.1.2 | Timing diagram / data graph: waveform view of measured signals over time. Digital waveform rendering (square waves). Configurable time scale. Scrollable history. Multi-channel stacked display. | L | src/runtime/timing-diagram.ts |
| 7.1.3 | Measurement ordering: UI to select which signals appear in data table/graph and in what order. Drag to reorder. Toggle visibility. Persist ordering in circuit model. | M | src/runtime/measurement-order.ts |
| 7.1.4 | Scope trigger integration: connect Scope component's trigger mechanism to global data graph. Triggered recording mode (record only when trigger fires). | M | src/runtime/scope-trigger.ts |

### Wave 7.2: Memory & Data Tools
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.2.1 | Memory hex editor dialog: click any RAM/ROM/EEPROM → open hex editor showing full address space. Edit values in hex/dec/bin. Changes apply to simulation state. Scrollable for large memories. | L | src/runtime/memory-editor.ts |
| 7.2.2 | Live memory viewer: memory editor contents update in real-time during simulation. Highlight changed addresses. | M | src/runtime/memory-viewer.ts |
| 7.2.3 | Program memory loader: file picker dialog for loading binary/hex data into memory components. Parse Intel HEX format, raw binary, CSV, Logisim format. Big-endian import option. Apply to selected memory component. | M | src/runtime/program-loader.ts |
| 7.2.4 | Single value dialog: inspect/modify individual signal or register values during simulation. Click a wire or pin → see value in all radix formats → optionally override. | M | src/runtime/value-dialog.ts |

### Wave 7.3: Test Authoring
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.3.1 | Test case editor: write/edit truth table test vectors in a code editor panel. Syntax highlighting for Digital's test format. Save test data into circuit's `Testcase` component. | M | src/testing/test-editor.ts |
| 7.3.2 | Run all tests (F11): batch-execute every `Testcase` component embedded in the circuit. Summary results. | S | src/testing/run-all.ts |
| 7.3.3 | Folder test runner: run tests across multiple .dig files in a directory. Aggregate results. | M | src/testing/folder-runner.ts |
| 7.3.4 | Behavioral fixture generator: auto-generate test fixture from circuit I/O (create test template with input signal names and output signal names pre-filled). | S | src/testing/fixture-generator.ts |

---

## Phase 8: Analysis & Synthesis
**Depends on**: Phase 6
**Parallel with**: Phase 7, Phase 9

Circuit analysis, truth table generation, boolean expression minimization, Karnaugh maps, and circuit synthesis. Port of Digital's `analyse` package.

### Wave 8.1: Circuit Analysis
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 8.1.1 | Model analyzer: analyze a combinational circuit → generate truth table. Identify inputs and outputs, evaluate all input combinations, record outputs. Handle multi-bit signals. Port Digital's `ModelAnalyser`. Cycle detector (port `CycleDetector`) — identify combinational feedback loops before analysis and report to user. | L | src/analysis/model-analyser.ts |
| 8.1.2 | Substitute library: port `SubstituteLibrary` — replace complex components (subcircuits, counters, etc.) with analysis-compatible gate-level equivalents for truth table generation. Required for analysis to work on circuits containing subcircuits or high-level components. | M | src/analysis/substitute-library.ts |
| 8.1.3 | Truth table display/editor: dialog showing truth table (input columns, output columns). Editable — user can modify output values. Reorder inputs/outputs. Support for don't-care entries. Synthesise from blank truth table (open empty table, fill manually, synthesize). | M | src/analysis/truth-table-ui.ts |
| 8.1.4 | State transition table: analyze sequential circuits (with flip-flops) → generate state transition table. Identify state variables, enumerate states, record transitions. | L | src/analysis/state-transition.ts |
| 8.1.5 | Truth table import/export: import from CSV files (map columns to signals). Export to CSV, Hex, LaTeX, TestCase format. Open/save `.tru` truth table files. | M | src/analysis/truth-table-io.ts |

### Wave 8.2: Expression Generation & Minimization
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 8.2.1 | Expression generation: truth table → boolean expressions (sum-of-products, product-of-sums). Port Digital's expression generation. Export expressions as LaTeX, plain text, condensed CSV. | M | src/analysis/expression-gen.ts |
| 8.2.2 | Quine-McCluskey minimization: minimize boolean expressions. Port Digital's `MinimizerQuineMcCluskey`. Handle don't-care terms. All solutions dialog (show all minimal solutions, not just one). | L | src/analysis/quine-mccluskey.ts |
| 8.2.3 | Karnaugh map visualization: display Karnaugh map for up to ~6 variables. Highlight prime implicants. Interactive — click cells to toggle. | L | src/analysis/karnaugh-map.ts |
| 8.2.4 | Expression editor dialog: enter/edit boolean expressions manually. Parse expression syntax. Validate. Convert between expression forms (SOP, POS, canonical). | M | src/analysis/expression-editor.ts |
| 8.2.5 | Expression modifiers: generate circuits using only NAND gates, only NOR gates, or with limited fan-in (N-input maximum). Port `NAnd.java`, `NOr.java`, `NInputs.java`. Teaching tool for gate-level design constraints. | M | src/analysis/expression-modifiers.ts |
| 8.2.6 | JK flip-flop synthesis: derive JK flip-flop excitation equations from state transition tables. Port Digital's `DetermineJKStateMachine`. | M | src/analysis/jk-synthesis.ts |

### Wave 8.3: Circuit Synthesis & Analysis Tools
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 8.3.1 | Circuit synthesis: generate a circuit from truth table or boolean expressions. Create gates, connect wires, produce a valid Circuit that can be loaded in the editor. Support expression modifier constraints (NAND-only, NOR-only, N-input). | L | src/analysis/synthesis.ts |
| 8.3.2 | Critical path analysis: calculate longest propagation path through combinational logic. Report path length and the components on the critical path. Port `ModelAnalyser.calcMaxPathLen()`. | M | src/analysis/path-analysis.ts |
| 8.3.3 | Statistics dialog: component count by type, total gates, total wires, circuit complexity metrics | S | src/analysis/statistics.ts |
| 8.3.4 | Dependency analysis: analyze which outputs depend on which inputs. Display dependency matrix. | M | src/analysis/dependency.ts |

---

## Phase 9: Export & Application Features
**Depends on**: Phase 6
**Parallel with**: Phase 7, Phase 8

Image export, localization, 74xx library, and application infrastructure.

### Wave 9.1: Circuit Export
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 9.1.1 | SVG export: render circuit to SVG. LaTeX-compatible text (optional LaTeX math in labels). SVG settings dialog (scale, margins, text format). Port Digital's `GraphicSVG`. | M | src/export/svg.ts |
| 9.1.2 | PNG export: render circuit to PNG image. Small and large resolution options. | S | src/export/png.ts |
| 9.1.3 | Animated GIF export: record simulation steps as frames, encode as animated GIF | M | src/export/gif.ts |
| 9.1.4 | ZIP archive export: bundle circuit file + all referenced subcircuit files + hex data files into a single ZIP | M | src/export/zip.ts |

### Wave 9.2: Localization
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 9.2.1 | i18n framework: string extraction system, locale switching, fallback to English. All UI strings go through i18n lookup. Multilingual component label support (component descriptions with multiple language versions). | M | src/i18n/framework.ts |
| 9.2.2 | Translation files: port Digital's translations for English, German, Spanish, Portuguese, French, Italian, simplified Chinese. Map Digital's `lang_XX.xml` keys to our i18n keys. | M | src/i18n/locales/\*.json |

### Wave 9.3: 74xx Library & Remote Interface
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 9.3.1 | 74xx IC library: port Digital's 74xx series subcircuit library. Ship as .dig files bundled with the app. Register in component palette under "74xx" category. Include: 74xx availability list in help. | M | lib/74xx/\*.dig, src/components/library-74xx.ts |
| 9.3.2 | **postMessage adapter over SimulatorFacade**: Thin browser-side adapter that translates `postMessage` events to SimulatorFacade calls. The facade (2.0.1) is the shared core — this task is only the message transport layer. Receives `digital-load-url` → `facade.loadDig(fetch(url))`. Receives `digital-load-data` → `facade.loadDig(atob(data))`. Sends `digital-ready`, `digital-loaded`, `digital-error`. Extended protocol for tutorial control: `digital-set-input { label, value }` → `facade.setInput()`, `digital-step` → `facade.step()`, `digital-read-output { label }` → responds with `{ type: 'digital-output', label, value }`, `digital-run-tests` → `facade.runTests()` → responds with `{ type: 'digital-test-results', results }`. | S | src/remote/postmessage-adapter.ts |

---

## Phase 10: FSM Editor
**Depends on**: Phase 8 (Analysis & Synthesis — needed for FSM→circuit)

Graphical finite state machine editor with circuit synthesis.

### Wave 10.1: FSM Model & Editor
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 10.1.1 | FSM model: `State` (name, position, output values), `Transition` (source, target, condition expression, action), `FSM` (states + transitions + metadata). Serialization. | M | src/fsm/model.ts |
| 10.1.2 | FSM graphical editor: separate canvas for drawing FSMs. Place states (circles/rectangles), draw transitions (curved arrows with labels), edit state/transition properties. Selection, move, delete, undo/redo. | L | src/fsm/editor.ts |

### Wave 10.2: FSM Synthesis
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 10.2.1 | FSM → state transition table: enumerate all states, evaluate transition conditions, produce transition table. Port Digital's `TransitionTableCreator`. | M | src/fsm/table-creator.ts |
| 10.2.2 | FSM → circuit: use Phase 8's synthesis engine to generate a sequential circuit (flip-flops + combinational logic) from the FSM. Wire through: FSM → transition table → truth tables → minimized expressions → circuit. | L | src/fsm/circuit-gen.ts |
| 10.2.3 | FSM optimizer: state minimization, encoding optimization. Port Digital's `Optimizer`. | M | src/fsm/optimizer.ts |

---

## Phase 11: Legacy Reference Review
**Depends on**: all previous phases

### Wave 11.1: Full Legacy Audit
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 11.1.1 | Search entire repository for stale references: `CheerpJ`, `Digital.jar`, `xstream`, `bridge.html`, `digital.html` (old), `Launcher.java`, `JVM.java`, Java package names, `.class` references, `jdk-shim`. Remove all. | M | (repo-wide) |
