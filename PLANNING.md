# Digital-in-Browser Planning Protocol

This document is the entry point for all planning and implementation work on the native JS circuit simulator.

**Authoritative implementation plan**: [`spec/plan.md`](spec/plan.md) — phases, waves, tasks, dependencies, verification.
**Progress tracking**: [`spec/progress.md`](spec/progress.md) — updated by implementation agents.

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

Replace the CheerpJ-based Digital.jar wrapper with a **native JavaScript/TypeScript port of hneemann/Digital** that runs purely as static files. This is a full-feature port: circuit editor, simulation engine, all ~107 components, circuit analysis and synthesis, FSM editor, test framework, data visualization, memory tools, export, localization, and 74xx library. The only excluded features are VHDL/Verilog co-simulation, JEDEC/CUPL export, and FPGA programming.

### Implementation Language

The simulator is a **full port to JavaScript/TypeScript**. The reference codebase (hneemann/Digital) is Java — agents read the Java source and write JS/TS equivalents. We do not use GWT, TeaVM, CheerpJ, or any Java-to-JS compilation toolchain. The output is hand-written strict TypeScript.

### Engine-Agnostic Editor (Architectural Constraint)

The editor/renderer/interaction layer MUST be engine-agnostic. The same canvas, grid, component placement, wire routing, selection, undo/redo, and property editing code must work with **any** simulation backend. The immediate backend is an event-driven digital engine. The author also maintains a GWT-compiled CircuitJS fork with an analog MNA engine — the TS editor layer should be reusable as a shared frontend for that analog backend in future, without forking the editor code.

Concretely:
- No simulation logic in canvas/editor code
- Simulation engine is a pluggable interface (start, stop, step, read/write signal values)
- Components declare which engine type they target
- Editor calls engine through the interface, never directly
- Components program against abstract `RenderContext` and engine interfaces, not Canvas2D or engine implementations

### Non-Goals (this phase)

- Porting the MNA analog simulation engine (stays in GWT for now)
- VHDL/Verilog export or co-simulation
- Circuit analysis / Quine-McCluskey minimization
- Replicating Digital's exact UI pixel-for-pixel
- Server-side anything — output is purely static files

### Constraints

- Purely static deployment (no server, no licensing fees)
- Must read hneemann/Digital `.dig` XML files (the existing tutorial circuits)
- Must embed in an iframe inside `tutorial.html` with the existing postMessage API
- Must support the full Digital component library (~102 types)

---

## 2. Reference Codebase

**hneemann/Digital** is the sole reference for porting. Agents read the Java source and write TypeScript equivalents.

| What | Where to look |
|---|---|
| Component simulation behaviour | `Digital/src/main/java/de/neemann/digital/core/` |
| .dig XML format | Any `.dig` file + Digital's XStream annotations |
| Circuit compilation (ModelCreator) | `Digital/src/main/java/de/neemann/digital/draw/model/` |
| Test execution | `Digital/src/main/java/de/neemann/digital/testing/` |
| Component shapes / rendering specs | `Digital/src/main/java/de/neemann/digital/draw/shapes/` |
| IEEE gate shapes | `Digital/src/main/java/de/neemann/digital/draw/shapes/ieee/` |
| Custom SVG shapes | `Digital/src/main/java/de/neemann/digital/draw/shapes/custom/` |

### Component Inventory (~102 types)

| Category | Source package | Types |
|---|---|---|
| Logic gates | `core/basic/` | And, Or, Not, NAnd, NOr, XOr, XNOr, Function |
| Flip-flops | `core/flipflops/` | FlipflopD, FlipflopDAsync, FlipflopJK, FlipflopJKAsync, FlipflopRS, FlipflopRSAsync, FlipflopT, Monoflop |
| Memory | `core/memory/` | Counter, CounterPreset, Register, RegisterFile, RAMSinglePort, RAMSinglePortSel, RAMDualPort, RAMDualAccess, RAMAsync, BlockRAMDualPort, ROM, ROMDualPort, EEPROM, EEPROMDualPort, LookUpTable, ProgramCounter, ProgramMemory |
| Arithmetic | `core/arithmetic/` | Add, Sub, Mul, Div, Neg, Comparator, BarrelShifter, BitCount, BitExtender, PRNG |
| I/O | `core/io/` | In, Out, InValue, Button, ButtonLED, Clock, Const, DipSwitch, Ground, VDD, PowerSupply, LED, LightBulb, RGBLED, Probe, NotConnected, MIDI, RotEncoder, StepperMotorBipolar, StepperMotorUnipolar |
| Switching | `core/switching/` | Switch, SwitchDT, PlainSwitch, PlainSwitchDT, Relay, RelayDT, NFET, PFET, FGNFET, FGPFET, TransGate, Fuse |
| Wiring | `core/wiring/` | Splitter, BusSplitter, Multiplexer, Demultiplexer, Decoder, BitSelector, PriorityEncoder, Driver, DriverInvSel, Delay, Break, Stop, Reset, AsyncSeq, Clock |
| PLD | `core/pld/` | Diode, DiodeBackward, DiodeForward, PullUp, PullDown |
| Display | (shapes) | SevenSeg, SevenSegHex, SixteenSeg, Scope |
| Graphics | `gui/components/graphics` | LedMatrix, VGA, GraphicCard |
| Terminal | `gui/components/terminal` | Terminal, Keyboard |
| Custom | (shapes/custom) | CustomShape (SVG-based user-defined symbols) |
| Misc | | Text, Subcircuit |

---

## 3. Implementation Workflow

Work follows the orchestrated plan in `spec/plan.md` (12 phases, ~130 tasks). The workflow per phase is:

1. **Spec** (`/plan-spec`) — detailed implementation spec for the phase, all design decisions made with the author
2. **Implement** (`/implement-orchestrated`) — parallel agent teams execute against the spec
3. **Review** (`/review-orchestrated`) — verify implementation against spec and rules

### Phase Overview

| Phase | What | Depends on |
|---|---|---|
| 0 | Dead code removal | — |
| 1 | Foundation & type system | 0 |
| 2 | Canvas editor (full feature set) | 1 |
| 3 | Simulation engine (all modes) | 1 |
| 4 | .dig parser & file I/O | 1 |
| 5 | Component library (~107 types) | 1 |
| 6 | Core integration | 2+3+4+5 |
| 7 | Runtime tools (data viz, memory, test authoring) | 6 |
| 8 | Analysis & synthesis | 6 |
| 9 | Export & application features | 6 |
| 10 | FSM editor | 8 |
| 11 | Legacy reference review | all |

Phases 2–5 run in parallel. Phases 7–9 run in parallel. See `spec/plan.md` for the full dependency graph.

### Key Principles

**Agents Must Read Specs First**: All implementation agents read `spec/plan.md` and the relevant phase spec before writing any code. Working without specs risks relitigating resolved decisions.

**One Authoritative Source**: Each topic has ONE authoritative spec file. All other documents reference it, never duplicate.

**Port, Don't Invent**: Component behaviour is defined by Digital's Java source. Agents read the source and write the TS equivalent. Do not redesign component semantics.

**Implementation Follows Spec**: If a spec is ambiguous, flag it and move on. Design decisions are resolved in spec sessions, not during implementation.

---

## 4. Specification Tree

```
spec/
├── plan.md                [Active]  Implementation plan — 12 phases, ~130 tasks
├── progress.md            [Active]  Task completion tracking
└── (phase specs created during /plan-spec sessions, one per phase)
```

---

## 5. postMessage API (preserved across port)

```
Parent → iframe:
  { type: 'digital-load-url', url: '<url>' }     — Load a .dig circuit file
  { type: 'digital-load-data', data: '<base64>' } — Load inline circuit data

Iframe → parent:
  { type: 'digital-ready' }                        — Simulator initialized
  { type: 'digital-loaded' }                       — Circuit file loaded
  { type: 'digital-error', error: '...' }          — Error occurred
```
