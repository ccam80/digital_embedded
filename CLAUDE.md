# Digital-in-Browser

## Project Overview

A browser-based digital logic circuit simulator for embedding in university course tutorials. The project is a **native TypeScript port of [hneemann/Digital](https://github.com/hneemann/Digital)** — purely static files, no server, no licensing dependencies.

**For all design and planning work, read `spec/plan.md` first.** It defines phases, tasks, dependencies, performance architecture, and verification criteria.

**Before writing any code, read `spec/author_instructions.md`.** It defines the TS idiom guide, priority order (architectural consistency > performance > ease), review checkpoints, and the component implementation template.

## Current State

The CheerpJ prototype files (`Digital.jar`, `digital.html`, `bridge.html`, `xstream-shim.jar`, `xstream-patch/`, `jdk-shim/`) are still in the repo pending Phase 0 cleanup. No native TS code has been written yet.

| File/Dir | Purpose |
|---|---|
| `spec/plan.md` | Authoritative implementation plan — 12 phases, ~160 tasks |
| `spec/progress.md` | Task completion tracking |
| `spec/phase-0-dead-code-removal.md` | Phase 0 detailed spec |
| `circuits/*.dig` | Example checkpoint circuits (AND gate, half adder, SR latch) |

## Reference Codebase

**hneemann/Digital** is the sole reference for porting. It is checked in as a git submodule at `ref/Digital/` (pinned to a specific commit for reproducibility). Agents read the Java source and write TypeScript equivalents.

To initialize: `git submodule update --init`

| What | Where to look |
|---|---|
| Component simulation behaviour | `ref/Digital/src/main/java/de/neemann/digital/core/` |
| .dig XML format | Any `.dig` file + Digital's XStream annotations |
| Circuit compilation (ModelCreator) | `ref/Digital/src/main/java/de/neemann/digital/draw/model/` |
| Test execution | `ref/Digital/src/main/java/de/neemann/digital/testing/` |
| Component shapes / rendering specs | `ref/Digital/src/main/java/de/neemann/digital/draw/shapes/` |
| HGS scripting interpreter | `ref/Digital/src/main/java/de/neemann/digital/hdl/hgs/` |
| Generic circuit resolution | `ref/Digital/src/main/java/de/neemann/digital/draw/library/ResolveGenerics.java` |
| Bus resolution subsystem | `ref/Digital/src/main/java/de/neemann/digital/core/wiring/bus/` |
| Analysis & synthesis | `ref/Digital/src/main/java/de/neemann/digital/analyse/` |
| FSM editor | `ref/Digital/src/main/java/de/neemann/digital/fsm/` |
| Element library (component registry) | `ref/Digital/src/main/java/de/neemann/digital/draw/library/ElementLibrary.java` |
| Example circuits (processors, 74xx) | `ref/Digital/src/main/dig/` |

### Engine-Agnostic Editor (Architectural Constraint)

The editor/renderer/interaction layer MUST be engine-agnostic. The same canvas, grid, component placement, wire routing, selection, undo/redo, and property editing code must work with **any** simulation backend. The immediate backend is an event-driven digital engine. The author also maintains a GWT-compiled CircuitJS fork with an analog MNA engine — the TS editor layer should be reusable as a shared frontend for that analog backend in future, without forking the editor code.

Concretely:
- No simulation logic in canvas/editor code
- Simulation engine is a pluggable interface (start, stop, step, read/write signal values)
- Components declare which engine type they target
- Editor calls engine through the interface, never directly
- Components program against abstract `RenderContext` and engine interfaces, not Canvas2D or engine implementations

## Serving Locally

**All files MUST be served over HTTP**, not opened as `file://` URLs.

~~~bash
python3 -m http.server 8080
~~~

## postMessage API (tutorial host ↔ simulator iframe)

This API must be preserved by the native JS simulator:

~~~
Parent → iframe:
  { type: 'digital-load-url', url: '<url>' }     — Load a .dig circuit file
  { type: 'digital-load-data', data: '<base64>' } — Load inline circuit data

Iframe → parent:
  { type: 'digital-ready' }                        — Simulator initialized
  { type: 'digital-loaded' }                       — Circuit file loaded
  { type: 'digital-error', error: '...' }          — Error occurred
~~~
