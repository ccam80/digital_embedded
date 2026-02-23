# Digital-in-Browser — Implementation Plan

Native JavaScript/TypeScript port of hneemann/Digital: the complete circuit editor, event-driven simulation engine, ~107-component library, circuit analysis and synthesis tools, FSM editor, test framework, and .dig file compatibility — deployed as purely static files in the browser.

## Goals

- A complete Canvas-based circuit editor with all of Digital's editing features: placement, wiring, selection, undo/redo, property editing, component palette, bus value annotations, search, label tools, presentation mode, color schemes, settings
- A pluggable event-driven digital simulation engine: propagation, delays, oscillation detection, clock management, micro-step mode, run-to-break, quick run
- The full Digital component library (~107 types) including display components (LED matrix, VGA, graphic card, terminal, keyboard) and custom SVG shapes
- Runtime inspection tools: live data table, timing diagram, measurement ordering, configurable value radix, memory hex editor, live memory viewer, program loader
- .dig XML import and native JSON save/load with full component coverage
- Subcircuit support: hierarchical embedding, recursive loading, engine flattening
- Test framework: truth table parser, test executor, test case editor, run-all, folder runner, behavioral fixture generator
- Circuit analysis and synthesis: truth table generation, boolean expression extraction, Quine-McCluskey minimization, Karnaugh map visualization, expression editor, circuit synthesis, path analysis, statistics, state transition tables
- Finite state machine editor: graphical FSM design, FSM-to-transition-table, FSM-to-circuit synthesis
- Export: SVG (with LaTeX compatibility), PNG, animated GIF, ZIP archive
- Tutorial integration: iframe embedding in tutorial.html with existing postMessage API
- Application features: localization (7 languages), 74xx IC library, color scheme editor, settings persistence, remote control interface

## Non-Goals

- VHDL/Verilog export or co-simulation
- JEDEC/CUPL export for programmable logic devices
- FPGA programming (BASYS3, TinyFPGA)
- Server-side anything — output is purely static files
- Replicating Digital's Swing UI pixel-for-pixel

## Verification

- **Phase 0**: No CheerpJ artifacts remain. `git status` shows only removals.
- **Phase 1**: `tsc --noEmit` passes. Vitest runs. Mock contexts work. `vite build` produces static output.
- **Phase 2**: Automated tests for all interaction modes. Bus annotations display mock values. Search finds elements. Label tools rename correctly. Color schemes switch rendering.
- **Phase 3**: Unit tests verify propagation, delays, oscillation, clocks. Micro-step advances one gate. Run-to-break halts at Break component. Quick-run completes without rendering calls.
- **Phase 4**: Parser reads all tutorial .dig files. Attribute mapping framework works. JSON round-trip is lossless.
- **Phase 5**: Each component has unit tests for logic and rendering. All 107 types registered with .dig attribute mappings. Display components (Terminal, VGA, LED Matrix) produce output to their display interfaces.
- **Phase 6**: End-to-end .dig load → render → simulate → subcircuits work. Engine-editor binding updates canvas live. postMessage API works with tutorial.html.
- **Phase 7**: Data table shows live values. Timing diagram records signals. Memory editor views/edits RAM contents during simulation. Test case editor creates and runs new tests. Hex file loads into memory components.
- **Phase 8**: Analyze circuit produces correct truth table. Expression minimization matches known results. Karnaugh map highlights prime implicants. Synthesis generates working circuit from truth table.
- **Phase 9**: SVG export produces valid SVG. PNG renders at correct resolution. Settings persist across sessions. i18n strings switch correctly. 74xx library circuits load as subcircuits.
- **Phase 10**: FSM editor draws states/transitions. FSM→table produces correct state transition table. FSM→circuit generates working sequential circuit.
- **Phase 11**: Repository-wide search for removed artifact names returns zero results.

## Dependency Graph

```
Phase 0 (Dead Code Removal)                         ─── runs first, alone
│
Phase 1 (Foundation & Types)                         ─── after 0
├──→ Phase 2 (Canvas Editor)             ─── parallel after 1 ──┐
├──→ Phase 3 (Simulation Engine)         ─── parallel after 1    │
├──→ Phase 4 (.dig Parser & File IO)     ─── parallel after 1    │
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

### Wave 0.1: Remove CheerpJ Stack
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 0.1.1 | Remove all CheerpJ artifacts: `Digital.jar`, `digital.html`, `bridge.html`, `test-bridge.html`, `xstream-shim.jar`, `xstream-patch/` (entire directory), `jdk-shim/` (entire directory), `stack-question-template.txt`. Delete `PLANNING.md` (superseded by `spec/plan.md`). Rewrite `CLAUDE.md` to reflect post-deletion repo state. | M | Digital.jar, digital.html, bridge.html, test-bridge.html, xstream-shim.jar, xstream-patch/\*, jdk-shim/\*, CLAUDE.md, PLANNING.md |

---

## Phase 1: Foundation & Type System
**Depends on**: Phase 0

Complete type system, interface contracts, and project infrastructure. Every interface defined here is the contract that Phases 2–10 implement against.

### Wave 1.1: Project Infrastructure
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.1.1 | TypeScript project setup: `package.json`, `tsconfig.json` (strict mode), Vite config, directory structure (`src/core/`, `src/editor/`, `src/engine/`, `src/components/`, `src/io/`, `src/testing/`, `src/analysis/`, `src/fsm/`), ESLint, `.gitignore`, Zod dependency | M | package.json, tsconfig.json, vite.config.ts |
| 1.1.2 | Test infrastructure: Vitest config, mock `RenderContext` (records draw calls), mock engine (tracks signal state), dev workflow (Vite dev → simulator.html → tutorial.html iframe), build verification script | M | vitest.config.ts, src/test-utils/\* |

### Wave 1.2: Core Type System
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.2.1 | Signal value types: `Bit` enum (ZERO, ONE, HIGH_Z, UNDEFINED), `BitVector` class (arbitrary-width multi-bit), signal arithmetic, comparison, number conversion, configurable display radix (bin/hex/dec/signed) | M | src/core/signal.ts |
| 1.2.2 | Pin system: `Pin` interface (direction, position, label, bit width, clock marker, negation bubble), `PinDirection` enum, N/S/E/W layout placement, connection state | M | src/core/pin.ts |
| 1.2.3 | Component property system: `PropertyDefinition`, `PropertyBag`, property types (INT, STRING, ENUM, BOOLEAN, BIT_WIDTH, HEX_DATA, COLOR), Zod schemas for serialization boundaries | M | src/core/properties.ts |

### Wave 1.3: Interface Contracts
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.3.1 | `CircuitElement` interface: identity, pin declarations, property declarations, bounding box, rotation/mirror. Rendering: `draw(ctx: RenderContext)`. Simulation: `init()`, `execute()`, `getOutput(pin)`. Serialization: `serialize()` / `deserialize()`. Help text declaration. | L | src/core/element.ts |
| 1.3.2 | Engine interface: pluggable simulation contract — `init`, `start`, `stop`, `step`, `microStep`, `runToBreak`, `reset`, `getSignalValue`, `setSignalValue`, `addChangeListener`. `EngineState` enum. `SimulationEvent` type. Measurement observation interface (for data table/graph). | L | src/core/engine-interface.ts |
| 1.3.3 | Renderer interface: drawing context abstraction — lines, rects, polygons, arcs, text, paths, fill/stroke. Style state (color, lineWidth, font). Coordinate types (Point, Rect, Transform). Color scheme interface (theme-switchable colors). | L | src/core/renderer-interface.ts |
| 1.3.4 | Circuit model: `Circuit` class (elements + nets), `Net` class (connected pins), `Wire` class (visual segments), component registry (type name → constructor). Measurement ordering (which signals to observe, in what order). | L | src/core/circuit.ts, src/core/registry.ts |

---

## Phase 2: Canvas Editor
**Depends on**: Phase 1
**Parallel with**: Phase 3, Phase 4, Phase 5

The complete interactive circuit editor with all of Digital's editing features.

### Wave 2.1: Canvas Foundation
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.1.1 | Canvas 2D renderer: implement renderer interface using Canvas 2D API. All drawing primitives. Transform stack for rotation/mirroring. Color scheme support (render all colors through theme indirection). | M | src/editor/canvas-renderer.ts |
| 2.1.2 | Coordinate system & grid: world ↔ screen transforms, grid rendering (major/minor lines), grid snapping, configurable grid size | M | src/editor/grid.ts, src/editor/coordinates.ts |
| 2.1.3 | Pan & zoom: mouse wheel zoom (centered on cursor), middle-click/space+drag pan, zoom limits, viewport management, fit-to-circuit | M | src/editor/viewport.ts |

### Wave 2.2: Element & Wire Rendering
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.2.1 | Component rendering dispatch: iterate elements, apply transforms, call `element.draw(ctx)`, pin indicators, selection highlighting | M | src/editor/element-renderer.ts |
| 2.2.2 | Wire rendering: Manhattan segments, junction dots, bus wires (thicker for multi-bit), wire color by signal state, **bus value annotations** (display multi-bit values as hex/dec labels on bus wires, configurable radix), selection highlighting | L | src/editor/wire-renderer.ts |

### Wave 2.3: Interaction Model
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.3.1 | Hit-testing: point-in-element, point-near-wire, point-on-pin, priority ordering, rectangular region intersection | L | src/editor/hit-test.ts |
| 2.3.2 | Selection model: click, shift-click, box-select, Ctrl+A, Escape, selection management | M | src/editor/selection.ts |
| 2.3.3 | Placement mode: palette ghost, grid snap, click-to-place, R to rotate, M to mirror, Escape to cancel | M | src/editor/placement.ts |
| 2.3.4 | Wire drawing mode: click output pin → Manhattan routing → waypoints → click input pin. Visual preview. Escape cancel. | L | src/editor/wire-drawing.ts |

### Wave 2.4: Core Edit Operations
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.4.1 | Move, copy, paste, delete: drag with grid snap, Ctrl+C/V/X, Delete, duplicate (Ctrl+D) | M | src/editor/edit-operations.ts |
| 2.4.2 | Undo/redo: command pattern for all operations. Ctrl+Z / Ctrl+Shift+Z. Configurable stack depth. | L | src/editor/undo-redo.ts |
| 2.4.3 | Component palette: categorized list (Logic, I/O, Flip-Flops, Memory, Arithmetic, Wiring, Switching, PLD, Misc, 74xx). Search/filter. Click to place. Collapsible categories. Insert history (recently placed). | M | src/editor/palette.ts |
| 2.4.4 | Property editor panel: type-appropriate inputs (number, text, enum, boolean, hex data, color). Immediate apply. Undo integration. | M | src/editor/property-panel.ts |
| 2.4.5 | Context menus & keyboard shortcuts: right-click menu, configurable shortcut map, default bindings | M | src/editor/context-menu.ts, src/editor/shortcuts.ts |

### Wave 2.5: Extended Editor Features
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.5.1 | Find/search (Ctrl+F): search for components and labels in circuit, highlight matches, navigate between results | S | src/editor/search.ts |
| 2.5.2 | Label tools: numbering wizard (auto-number component labels), add/remove label prefix (batch), auto-label pins, reorder input/output pin ordering | M | src/editor/label-tools.ts |
| 2.5.3 | Insert selection as new subcircuit: convert selected components+wires into a subcircuit, auto-create interface pins from cut wires | L | src/editor/insert-subcircuit.ts |
| 2.5.4 | Auto power supply: scan circuit for unconnected power pins, auto-add VDD/GND connections | S | src/editor/auto-power.ts |
| 2.5.5 | Element help dialog: right-click any component → show documentation (description, pin table, behavior, truth table where applicable). Content from component help text declarations. | M | src/editor/element-help.ts |
| 2.5.6 | Presentation mode (F4): fullscreen canvas, simplified toolbar, hidden palette/property panel, enlarged components for projection | M | src/editor/presentation.ts |
| 2.5.7 | Color scheme framework: built-in schemes (default, high contrast, monochrome), color scheme editor (customize colors), apply scheme to all rendering | M | src/editor/color-scheme.ts |
| 2.5.8 | Settings dialog: application preferences (grid size, default gate delay, color scheme, language, simulation speed, radix default). Persist to localStorage. | M | src/editor/settings.ts |
| 2.5.9 | File history: recent files list in File menu, persist to localStorage. | S | src/editor/file-history.ts |

---

## Phase 3: Simulation Engine
**Depends on**: Phase 1
**Parallel with**: Phase 2, Phase 4, Phase 5

The complete event-driven digital simulation engine with all of Digital's simulation modes.

### Wave 3.1: Core Engine
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.1.1 | Event priority queue: min-heap by timestamp, O(log n) insert/extract, batch simultaneous events, stable ordering | M | src/engine/event-queue.ts |
| 3.1.2 | Signal propagation loop: implement engine interface. Evaluate → schedule → propagate → repeat until stable. Multi-bit signals. Initial state resolution. | L | src/engine/propagation.ts, src/engine/digital-engine.ts |

### Wave 3.2: Circuit Compilation
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.2.1 | Circuit compiler: visual Circuit → executable graph. Port Digital's ModelCreator: topological ordering, sequential element identification, clock domain assignment. | L | src/engine/compiler.ts |
| 3.2.2 | Net resolution: trace wire connections to nets, validate bus width consistency, detect errors (unconnected inputs, shorted outputs, width mismatches) | M | src/engine/net-resolver.ts |

### Wave 3.3: Advanced Features
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.3.1 | Propagation delay model: configurable gate delay, delay accumulation, setup/hold checking for flip-flops | M | src/engine/delay.ts |
| 3.3.2 | Feedback & oscillation detection: compile-time feedback warnings, runtime oscillation detection (net toggling > N times), force UNDEFINED and halt | M | src/engine/oscillation.ts |
| 3.3.3 | Clock management: identify clock sources, configurable frequency, edge scheduling, multi-clock domains | M | src/engine/clock.ts |

### Wave 3.4: Simulation Modes
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.4.1 | Standard controls: state machine (STOPPED/RUNNING/PAUSED/ERROR), step (full propagation cycle), run (rAF-driven, configurable speed), pause, reset | M | src/engine/controls.ts |
| 3.4.2 | Micro-step mode: advance one single gate evaluation (not a full propagation cycle). Show which gate just evaluated. For teaching signal propagation order. | M | src/engine/micro-step.ts |
| 3.4.3 | Run-to-break: run simulation until a Break component fires, then halt. Support both normal-speed and micro-step run-to-break. | M | src/engine/run-to-break.ts |
| 3.4.4 | Quick run: run simulation at maximum speed with no rendering callbacks (suppress change listeners). For computation-heavy circuits. Speed test benchmark mode. | S | src/engine/quick-run.ts |

---

## Phase 4: .dig Parser & File I/O
**Depends on**: Phase 1
**Parallel with**: Phase 2, Phase 3, Phase 5

### Wave 4.1: .dig XML Parser
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 4.1.1 | .dig XML schema documentation: analyze Digital's format from XStream annotations and fixture files. Document complete structure. TypeScript type definitions for parsed tree. | M | src/io/dig-schema.ts |
| 4.1.2 | .dig XML parser: DOMParser-based. Extract visual elements, wires, measurement ordering, test data, embedded subcircuit definitions. Strongly-typed parse tree. | L | src/io/dig-parser.ts |

### Wave 4.2: Attribute Mapping & Circuit Construction
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 4.2.1 | Attribute mapping framework: mechanism for components to register their own .dig XML attribute mappings. Reusable converters for common patterns (Bits→width, Value→initial, Label→label, enum mapping, coordinate transform, boolean). Individual mappings registered by components in Phase 5. | M | src/io/attribute-map.ts |
| 4.2.2 | Circuit construction from parsed XML: look up component type in registry, create instance, apply registered attribute mappings, position element. Create wires. Construct Circuit model. Fail hard on unknown component types. | M | src/io/dig-loader.ts |

### Wave 4.3: Native Save/Load Format
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 4.3.1 | JSON save: serialize Circuit to JSON (elements, properties, positions, wires, metadata, format version). Stable key ordering. | M | src/io/save.ts |
| 4.3.2 | JSON load: deserialize with Zod validation, format version checking, migration support | M | src/io/load.ts |

---

## Phase 5: Component Library
**Depends on**: Phase 1
**Parallel with**: Phase 2, Phase 3, Phase 4

All ~107 component types. Each component: rendering via `RenderContext`, simulation logic via engine interface, .dig attribute mapping registration, unit tests with mock contexts. Reference: hneemann/Digital Java source exclusively.

### Wave 5.1: Foundation Components (validate interfaces, establish patterns)
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 5.1.1 | Standard logic gates: `And`, `Or`, `Not`, `NAnd`, `NOr`, `XOr`, `XNOr` — configurable 2-N inputs, US + IEEE/IEC shapes, truth table logic. Template-setting implementations. | L | src/components/gates/\*.ts |
| 5.1.2 | Basic I/O: `In` (interactive toggle), `Out` (display value with configurable radix), `Clock` (configurable frequency), `Const`, `Ground`, `VDD`, `NotConnected` | M | src/components/io/basic.ts |
| 5.1.3 | Drivers & basic wiring: `Driver`, `DriverInvSel`, `Splitter`, `BusSplitter` | M | src/components/wiring/splitter.ts |

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
| 5.2.9 | RAM: `RAMSinglePort`, `RAMSinglePortSel`, `RAMDualPort`, `RAMDualAccess`, `RAMAsync`, `BlockRAMDualPort` — configurable address/data width, hex initialization. Expose memory contents interface for live viewer (Phase 7). | L | src/components/memory/ram.ts |
| 5.2.10 | ROM & EEPROM: `ROM`, `ROMDualPort`, `EEPROM`, `EEPROMDualPort` — hex data, address/data config | M | src/components/memory/rom.ts |
| 5.2.11 | Specialty memory: `LookUpTable`, `ProgramCounter`, `ProgramMemory` | M | src/components/memory/special.ts |
| 5.2.12 | Switches: `Switch`, `SwitchDT`, `PlainSwitch`, `PlainSwitchDT` — interactive toggle, SPST/SPDT | M | src/components/switching/switch.ts |
| 5.2.13 | Relays: `Relay`, `RelayDT` — coil-controlled contacts, SPST/SPDT | M | src/components/switching/relay.ts |
| 5.2.14 | FETs & transmission gate: `NFET`, `PFET`, `FGNFET`, `FGPFET`, `TransGate` | M | src/components/switching/fet.ts |
| 5.2.15 | Fuse: one-time, irreversible | S | src/components/switching/fuse.ts |
| 5.2.16 | PLD: `Diode`, `DiodeBackward`, `DiodeForward`, `PullUp`, `PullDown` | S | src/components/pld/\*.ts |
| 5.2.17 | Interactive I/O: `Button`, `ButtonLED`, `DipSwitch`, `Probe` (measurement source with configurable radix), `PowerSupply` | M | src/components/io/interactive.ts |
| 5.2.18 | Visual indicators: `LED` (configurable color), `LightBulb`, `RGBLED` | M | src/components/io/indicators.ts |
| 5.2.19 | Segment displays: `SevenSeg`, `SevenSegHex`, `SixteenSeg` | M | src/components/io/display.ts |
| 5.2.20 | Oscilloscope: `Scope` — multi-channel waveform recording, time scale, trigger, channel labels | L | src/components/io/scope.ts |
| 5.2.21 | Rotary encoder & motors: `RotEncoder`, `StepperMotorBipolar`, `StepperMotorUnipolar` | M | src/components/io/electromechanical.ts |
| 5.2.22 | MIDI: `MIDI` — note on/off, channel, velocity. Web MIDI API. | M | src/components/io/midi.ts |
| 5.2.23 | Function: generic boolean function from truth table, truth table editor | M | src/components/basic/function.ts |
| 5.2.24 | Text annotation: non-functional label, configurable font/style | S | src/components/misc/text.ts |
| 5.2.25 | LED Matrix: `LedMatrix` — NxN LED grid display. Separate display panel/dialog showing the matrix output updating during simulation. | M | src/components/graphics/led-matrix.ts |
| 5.2.26 | VGA display: `VGA` — VGA-resolution pixel display component. Display panel showing framebuffer contents. | L | src/components/graphics/vga.ts |
| 5.2.27 | Graphic card: `GraphicCard` — graphics framebuffer with drawing commands. Display panel. | L | src/components/graphics/graphic-card.ts |
| 5.2.28 | Terminal: `Terminal` — serial text terminal (character display + keyboard input). Terminal panel with scrollback. `Keyboard` — keyboard input component. Keyboard dialog for input. | M | src/components/terminal/terminal.ts, src/components/terminal/keyboard.ts |

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
| 6.1.1 | Connect .dig parser to component registry: wire parser + attribute mappings to populated registry. Load tutorial .dig files end-to-end. Verify `and-gate.dig`, `half-adder.dig`, `sr-latch.dig`. | M | src/io/dig-loader.ts |
| 6.1.2 | Engine-editor binding: connect real engine to real editor through Phase 1 interfaces. State changes trigger redraws. Wire colors show live values. Interactive components respond during simulation. | M | src/integration/editor-binding.ts |

### Wave 6.2: Subcircuit Support
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.2.1 | Subcircuit component type: rectangular chip rendering with interface pins, pin mapping, property editing | M | src/components/subcircuit/subcircuit.ts |
| 6.2.2 | Recursive .dig loading: load subcircuit definitions recursively, cache loaded definitions, detect circular references, nested subcircuits | L | src/io/subcircuit-loader.ts |
| 6.2.3 | Subcircuit engine flattening: inline into parent simulation graph, map interface pins, scoped naming, multiple instances, nested flattening | L | src/engine/flatten.ts |

### Wave 6.3: Test Execution
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.3.1 | Truth table parser: parse Digital's test syntax from .dig files — signal names, input/output values, don't-care, clock directives, repeat/loop, comments | M | src/testing/parser.ts |
| 6.3.2 | Test executor: drive inputs per vector, run to stable, compare outputs, collect pass/fail per vector | M | src/testing/executor.ts |
| 6.3.3 | Test results display: table with pass/fail, highlight mismatches, summary, run/re-run | M | src/testing/results-ui.ts |

### Wave 6.4: Tutorial Integration
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.4.1 | Simulator HTML page: standalone page with canvas, palette, property panel, toolbar (file ops, sim controls, test runner). Responsive layout. Works standalone and in iframe. | M | simulator.html, src/main.ts |
| 6.4.2 | postMessage API: receive `digital-load-url` / `digital-load-data`, send `digital-ready` / `digital-loaded` / `digital-error` | M | src/io/postmessage.ts |
| 6.4.3 | tutorial.html update: point iframe to new simulator, verify all tutorial steps, verify URL params | S | tutorial.html |

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
| 7.2.3 | Program memory loader: file picker dialog for loading binary/hex data into memory components. Parse Intel HEX format, raw binary, CSV. Apply to selected memory component. | M | src/runtime/program-loader.ts |
| 7.2.4 | Single value dialog: inspect/modify individual signal or register values during simulation. Click a wire or pin → see value in all radix formats → optionally override. | M | src/runtime/value-dialog.ts |

### Wave 7.3: Test Authoring
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.3.1 | Test case editor: write/edit truth table test vectors in a code editor panel. Syntax highlighting for Digital's test format. Save test data into circuit. | M | src/testing/test-editor.ts |
| 7.3.2 | Run all tests (F11): batch-execute every test case embedded in the circuit. Summary results. | S | src/testing/run-all.ts |
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
| 8.1.1 | Model analyzer: analyze a combinational circuit → generate truth table. Identify inputs and outputs, evaluate all input combinations, record outputs. Handle multi-bit signals. Port Digital's `ModelAnalyser`. | L | src/analysis/model-analyser.ts |
| 8.1.2 | Truth table display/editor: dialog showing truth table (input columns, output columns). Editable — user can modify output values. Reorder inputs/outputs. Support for don't-care entries. | M | src/analysis/truth-table-ui.ts |
| 8.1.3 | State transition table: analyze sequential circuits (with flip-flops) → generate state transition table. Identify state variables, enumerate states, record transitions. | L | src/analysis/state-transition.ts |
| 8.1.4 | CSV import: import truth tables from CSV files. Map columns to signals. | S | src/analysis/csv-import.ts |

### Wave 8.2: Expression Generation & Minimization
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 8.2.1 | Expression generation: truth table → boolean expressions (sum-of-products, product-of-sums). Port Digital's expression generation. | M | src/analysis/expression-gen.ts |
| 8.2.2 | Quine-McCluskey minimization: minimize boolean expressions. Port Digital's `MinimizerQuineMcCluskey`. Handle don't-care terms. | L | src/analysis/quine-mccluskey.ts |
| 8.2.3 | Karnaugh map visualization: display Karnaugh map for up to ~6 variables. Highlight prime implicants. Interactive — click cells to toggle. | L | src/analysis/karnaugh-map.ts |
| 8.2.4 | Expression editor dialog: enter/edit boolean expressions manually. Parse expression syntax. Validate. Convert between expression forms (SOP, POS, canonical). | M | src/analysis/expression-editor.ts |
| 8.2.5 | JK flip-flop synthesis: derive JK flip-flop excitation equations from state transition tables. Port Digital's `DetermineJKStateMachine`. | M | src/analysis/jk-synthesis.ts |

### Wave 8.3: Circuit Synthesis & Analysis Tools
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 8.3.1 | Circuit synthesis: generate a circuit from truth table or boolean expressions. Create gates, connect wires, produce a valid Circuit that can be loaded in the editor. | L | src/analysis/synthesis.ts |
| 8.3.2 | Critical path analysis: calculate longest propagation path through combinational logic. Report path length and the components on the critical path. | M | src/analysis/path-analysis.ts |
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
| 9.2.1 | i18n framework: string extraction system, locale switching, fallback to English. All UI strings go through i18n lookup. | M | src/i18n/framework.ts |
| 9.2.2 | Translation files: port Digital's translations for English, German, Spanish, Portuguese, French, Italian, simplified Chinese. Map Digital's `lang_XX.xml` keys to our i18n keys. | M | src/i18n/locales/\*.json |

### Wave 9.3: 74xx Library & Remote Interface
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 9.3.1 | 74xx IC library: port Digital's 74xx series subcircuit library. Ship as .dig files bundled with the app. Register in component palette under "74xx" category. Include: 74xx availability list in help. | M | lib/74xx/\*.dig, src/components/library-74xx.ts |
| 9.3.2 | Remote control interface: JavaScript API (or extended postMessage protocol) for external tools to control the simulator — load circuit, set inputs, read outputs, step, run, query state. For IDE integration and automated testing. | M | src/remote/interface.ts |

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
