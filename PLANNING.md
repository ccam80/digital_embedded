# Digital-in-Browser Planning Protocol

This document guides design and implementation sessions for the native JS circuit simulator. It is the single entry point for all planning work.

**Before any design or planning work**: Read this file in full, then read `specs/architecture.md` (once it exists). These two documents constrain every decision.

**To continue planning**: Read this file. Pick the next incomplete design session from Section 4 and work through it with the author.

---

## 0. Document Standards

**All spec and planning documents must reflect current truth, not history.**

- No changelogs, session logs, or "what changed" sections
- No dates except where semantically meaningful
- If something was decided, write the decision — not the process of deciding
- When updating a spec, replace outdated content; don't append corrections

**Why**: Future agents read these documents cold. Historical context creates confusion about what's actually true now.

---

## 1. Project Goal

Replace the CheerpJ-based Digital.jar wrapper with a **native JavaScript/TypeScript circuit simulator** that runs purely as static files. The simulator must support the full interactive workflow used in university course tutorials: place components, draw wires, build subcircuits, run tests, import hex into memory, and load/save .dig files.

### Non-Goals

- Analog simulation (no SPICE, no continuous-time)
- VHDL/Verilog export
- Circuit analysis / Quine-McCluskey minimization
- Replicating Digital's exact UI pixel-for-pixel

### Constraints

- Purely static deployment (no server, no licensing fees)
- Must read hneemann/Digital `.dig` XML files (the existing tutorial circuits)
- Must embed in an iframe inside `tutorial.html` with the existing postMessage API
- Must support: gates, flip-flops, MUX/DEMUX, arithmetic, counters, shift registers, RAM/ROM with hex import, subcircuits, embedded test cases

---

## 2. Source Material

Three reference codebases provide the implementation spec. Agents porting components or designing subsystems should read the relevant source directly.

| Source | What to take | What to discard |
|--------|-------------|-----------------|
| **[hneemann/Digital](https://github.com/hneemann/Digital)** (Java, GPLv3) | `.dig` XML format, simulation semantics, component behaviour, test framework, ModelCreator compilation logic | Swing GUI, XStream serialization, VHDL/Verilog export, circuit analysis |
| **[sharpie7/circuitjs1](https://github.com/sharpie7/circuitjs1)** (Java/GWT, GPL-2.0) | Canvas editor interaction (grid, place, wire, select, move, undo/redo), gate/chip rendering, `ChipElm` pin layout system, digital component `execute()` logic, subcircuit system (`CustomCompositeElm`) | Analog MNA simulation engine, all analog components, GWT framework code, voltage-based visualization |
| **Author's CircuitJS fork** (local, GPL-2.0) | Already-customized editor, known codebase. Primary port reference for editor and components — use this fork, not upstream, so existing customizations carry over. | Same as upstream CircuitJS |

The author already maintains a CircuitJS fork in another project. This fork is the primary reference for porting the editor and digital components. Digital (hneemann) is the reference for simulation semantics, .dig file format, and test execution.

### CircuitJS Editor Assets (port targets)

| CircuitJS class | What it provides | Port priority |
|-----------------|-----------------|---------------|
| `CircuitElm` (base) | Two-point element model, hit-testing, selection, serialization contract | **Critical** |
| `ChipElm` | Rectangular IC body, `Pin` inner class (N/S/E/W placement, labels, clock/bubble), `setupPins()`/`execute()` contract | **Critical** |
| `GateElm` | Gate shapes (US/European), 2-8 input fan-in, `calcFunction()` contract | **Critical** |
| `CirSim` (partial) | Grid snap, pan/zoom, placement modes, selection model, undo/redo, context menus | **Critical** (extract interaction, discard simulation) |
| `Graphics` | Canvas 2D wrapper (`drawLine`, `fillPolygon`, `drawString`) | **Useful** (thin, ~200 lines) |

### CircuitJS Digital Components Already Present

| Category | Components |
|----------|-----------|
| Gates | AND, OR, XOR, NAND, NOR, Inverter (2-8 inputs, US/Euro styles) |
| Flip-flops | D, JK, T flip-flops (with set/reset), Latch |
| Counters | Counter (configurable bits, modulus, up/down), Ring counter |
| Shift registers | SIPO, PISO |
| MUX/routing | Multiplexer, Demultiplexer |
| Arithmetic | Half adder, Full adder |
| Memory | SRAM (configurable address/data bits) |
| I/O & display | Logic input, Logic output, Clock, LED, 7-seg, 7-seg decoder |
| Misc | Tri-state buffer, Delay buffer, Custom logic (truth table) |
| Subcircuits | CustomCompositeElm (hierarchical, model-referenced) |

### Digital (hneemann) Simulation Assets (port targets)

| Digital class | What it provides | Port priority |
|---------------|-----------------|---------------|
| `de.neemann.digital.core.*` | Signal types, element interface, propagation | **Critical** |
| `de.neemann.digital.draw.model.ModelCreator` | Circuit compiler (visual → execution DAG) | **Critical** |
| `de.neemann.digital.draw.elements.Circuit` | .dig deserialization, circuit graph | **Critical** |
| `de.neemann.digital.testing.*` | TestExecutor, test data parser | **Critical** |
| `de.neemann.digital.core.basic.*` | Gate logic | Via component library |
| `de.neemann.digital.core.flipflops.*` | FF logic | Via component library |
| `de.neemann.digital.core.memory.*` | RAM/ROM logic, hex import | Via component library |
| `de.neemann.digital.core.io.*` | Input/Output/Probe/Clock | Via component library |

---

## 3. Session Types

Work is divided into two types of session with different models and goals.

### Design Sessions (Opus)

Purpose: Architecture, interfaces, contracts, rules. Output is spec documents that implementation sessions execute against.

- Author steers all design decisions
- Agent presents options with tradeoffs (tables preferred)
- Output goes to `specs/` directory as the ONE authoritative source for each topic
- Each session ends with updated spec files and this planning doc

### Implementation Sessions (Sonnet, parallel)

Purpose: Write code against specs. Multiple sessions can run in parallel on independent modules.

- Agent reads the relevant spec(s) from `specs/` before writing any code
- Agent follows the component template and coding conventions from `specs/component-contract.md`
- No architectural decisions — if a spec is ambiguous, stop and flag it for a design session
- Each session ends with working, tested code for its assigned module

**Rule**: Implementation sessions MUST NOT make architectural decisions. If the spec doesn't cover something, create a placeholder and flag it. Design sessions resolve ambiguities.

---

## 4. Design Sessions (Opus)

Status: `[Not started]` → `[In progress]` → `[Complete]`

| # | Session | Status | Output Spec |
|---|---------|--------|-------------|
| **D1** | **Core architecture & module boundaries** — Module structure (Editor, Engine, Components, FileIO), inter-module interfaces, tech choices (vanilla JS vs framework, Canvas library vs raw), build tooling, project layout | [Not started] | `specs/architecture.md` |
| **D2** | **Component contract & template** — Base `CircuitElement` class, `Pin` system, rendering contract, simulation contract (`resolve()`/`execute()`), serialization contract, property editing contract. Write one complete reference component (AND gate) as the template. Component registration/factory pattern. | [Not started] | `specs/component-contract.md` |
| **D3** | **Simulation engine** — Event-driven propagation model, event queue, discrete signal states (0/1/X/Z, multi-bit), propagation delay, feedback/oscillation detection, clock domains, how subcircuits flatten into the event graph. How Digital's `ModelCreator` logic maps to this design. | [Not started] | `specs/engine.md` |
| **D4** | **Editor interaction & rendering** — Canvas rendering pipeline, hit-testing, wire routing (Manhattan), selection model, placement modes, grid snap, pan/zoom, undo/redo (snapshot vs command pattern), property dialogs, component palette. What to port from CircuitJS's `CirSim` vs build fresh. | [Not started] | `specs/editor.md` |
| **D5** | **File I/O & .dig compatibility** — .dig XML schema (from Digital's XStream annotations), parser design, field mapping to internal model. CircuitJS native format support. Save format (JSON? XML?). What .dig features are supported vs unsupported. | [Not started] | `specs/file-io.md` |

### Design Session Dependencies

```
D1 (architecture)
├──→ D2 (component contract)
├──→ D3 (engine)
├──→ D4 (editor)
└──→ D5 (file I/O)

D2 ──→ all implementation sessions (defines the template)
D3 ──→ S2 (engine implementation)
D4 ──→ S1, S3 (canvas, interaction)
D5 ──→ S4 (serialization)
```

---

## 5. Implementation Sessions (Sonnet, parallel where possible)

Status: `[Not started]` → `[In progress]` → `[Complete]`

### Foundation (sequential — each depends on previous)

| # | Session | Depends on | Status |
|---|---------|-----------|--------|
| **S1** | Canvas renderer, grid, pan/zoom, coordinate system | D1, D4 | [Not started] |
| **S2** | Event-driven simulation engine + event queue | D1, D3 | [Not started] |
| **S3** | Element placement, wire drawing, selection, delete, undo/redo | D4, S1 | [Not started] |
| **S4** | File I/O (.dig XML import, native save/load) | D5, S1 | [Not started] |

### Component Library (parallel — all depend on D2 + S1 + S2 only)

Each session ports a batch of components following the template from D2. Agent reads the Java source from Digital and/or CircuitJS, writes the JS equivalent.

| # | Batch | Components | Status |
|---|-------|-----------|--------|
| **C1** | Logic gates | AND, OR, XOR, NAND, NOR, NOT, Buffer, Tri-state (~8) | [Not started] |
| **C2** | Flip-flops & latches | D-FF, JK-FF, T-FF, SR latch, D-latch (~5) | [Not started] |
| **C3** | Counters & registers | Counter, ring counter, SIPO, PISO shift registers (~4) | [Not started] |
| **C4** | MUX & routing | Multiplexer, demultiplexer, decoder, priority encoder (~4) | [Not started] |
| **C5** | Arithmetic | Half adder, full adder, comparator, negator (~4) | [Not started] |
| **C6** | Memory | SRAM, ROM, hex import/export (~3, most complex batch) | [Not started] |
| **C7** | I/O & display | Logic input, output, clock, LED, 7-seg, 7-seg decoder, hex display (~7) | [Not started] |
| **C8** | Wiring & utility | Splitter, tunnel/label, ground, power, text annotation (~5) | [Not started] |
| **C9** | Subcircuits | Hierarchical embedding, pin mapping, recursive loading (~1, complex) | [Not started] |
| **C10** | Testing | Truth table parser, test executor, results display (~2) | [Not started] |

### Integration (sequential)

| # | Session | Depends on | Status |
|---|---------|-----------|--------|
| **I1** | Wire modules together, component palette/menu, property dialogs | S1-S4, C1-C10 | [Not started] |
| **I2** | .dig import end-to-end (load Digital tutorial circuits) | I1 | [Not started] |
| **I3** | tutorial.html integration (iframe, postMessage API) | I1 | [Not started] |
| **I4** | Testing, polish, bug fixes | All above | [Not started] |

---

## 6. Specification Tree

Status: `[None]` → `[Draft]` → `[Approved]`

```
specs/
├── architecture.md              [None] Module structure, tech choices, interfaces
├── component-contract.md        [None] Base class, Pin, rendering/sim/serialization contracts, AND gate template
├── engine.md                    [None] Event-driven simulation, signal types, propagation, clock domains
├── editor.md                    [None] Canvas pipeline, interaction model, undo/redo
├── file-io.md                   [None] .dig XML mapping, save format, parser design
└── components/
    └── (individual component notes if needed during design)
```

### Dependency Graph

```
architecture.md
    └──→ ALL other specs

component-contract.md
    └──→ ALL component implementation sessions (C1-C10)

engine.md
    └──→ S2 (engine implementation)
    └──→ component-contract.md (simulation interface)

editor.md
    └──→ S1 (canvas), S3 (interaction)

file-io.md
    └──→ S4 (serialization)
```

---

## 7. Key Principles

### Agents Must Read Specs First

**All planning agents MUST read this file and `specs/architecture.md` before starting any design work.** All implementation agents MUST read `specs/component-contract.md` and the spec relevant to their assigned module. Working without these risks relitigating resolved decisions.

### One Authoritative Source

Each topic has ONE authoritative spec file (Section 6). All other documents reference it, never duplicate. When a design decision is made, it goes into the ONE spec — not into chat, not into code comments, not into a second document.

### Port, Don't Invent

The component library is a **port**, not a design exercise. Component behaviour is defined by Digital's Java source. Component rendering and editor interaction are defined by CircuitJS's Java source. Agents read the source and write the JS equivalent. Do not redesign component semantics.

### Implementation Follows Spec

Implementation sessions execute against specs. If a spec is unclear or incomplete, the implementation session flags it and moves on to a different task. Design sessions resolve ambiguities. This separation prevents implementation sessions from making ad-hoc architectural decisions that conflict with the overall design.

---

## 8. Session Handoff

When author says "end session", "wrap up", or "let's stop":

1. All approved decisions written to their ONE authoritative spec file
2. Session statuses updated in Sections 4 and 5
3. Blockers documented (which items are waiting on what)
4. Ripple check — did changes affect dependent specs?

**To resume**: "Read PLANNING.md, then continue from where we left off."
