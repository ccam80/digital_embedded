# Digital-in-Browser

## Project Overview

A browser-based digital logic circuit simulator for embedding in university course tutorials. The project is transitioning from a CheerpJ wrapper around hneemann/Digital.jar to a **native JavaScript/TypeScript implementation** — purely static files, no server, no licensing dependencies.

**For all design and planning work, read `PLANNING.md` first.** It defines the session structure, spec tree, and design dependencies.

## Current State

### Working (CheerpJ prototype, `main` branch)

The CheerpJ prototype is functional: Digital.jar runs in-browser with hot-reload via a native method bridge (`Launcher.java`). This will be superseded by the native JS simulator.

| File | Purpose |
|---|---|
| `Digital.jar` | hneemann/Digital v0.31 (3.7 MB Swing app) |
| `tutorial.html` | Split-pane tutorial viewer (instructions + live sim) |
| `tutorial.json` | Tutorial step definitions (title, HTML content, checkpoint .dig path) |
| `digital.html` | CheerpJ Swing loader with native method bridge for hot-reload |
| `xstream-shim.jar` | Patched XStream JVM class + Launcher bridge (Java 8 bytecode) |
| `bridge.html` | Headless simulation bridge (CheerpJ library mode) |
| `circuits/*.dig` | Example checkpoint circuits (AND gate, half adder, SR latch) |
| `xstream-patch/` | Java source for xstream-shim.jar (JVM.java, Launcher.java) |

### Planned (native JS simulator)

Replacing the CheerpJ stack with a native Canvas-based circuit editor and event-driven simulation engine. Ported from two reference codebases:

- **[hneemann/Digital](https://github.com/hneemann/Digital)** — simulation semantics, .dig file format, component behaviour, test framework
- **[sharpie7/circuitjs1](https://github.com/sharpie7/circuitjs1)** — canvas editor interaction, gate/chip rendering, digital component logic

See `PLANNING.md` for the full session plan and `specs/` for design specifications.

## Reference Codebases

When porting components or designing subsystems, read the relevant Java source directly:

| What | Where to look |
|---|---|
| Component simulation behaviour | `Digital/src/main/java/de/neemann/digital/core/` |
| .dig XML format | Any `.dig` file + Digital's XStream annotations |
| Circuit compilation (ModelCreator) | `Digital/src/main/java/de/neemann/digital/draw/model/` |
| Test execution | `Digital/src/main/java/de/neemann/digital/testing/` |
| Canvas editor interaction | `circuitjs1/src/com/lushprojects/circuitjava/CirSim.java` |
| Gate rendering / chip layout | `circuitjs1/src/com/lushprojects/circuitjava/GateElm.java`, `ChipElm.java` |
| Digital component execute() | `circuitjs1/src/com/lushprojects/circuitjava/*Elm.java` |

## Serving Locally

**All files MUST be served over HTTP**, not opened as `file://` URLs.

~~~bash
python3 -m http.server 8080
# Then open: http://localhost:8080/tutorial.html
~~~

## Tutorial Authoring Format

`tutorial.json`:

~~~json
{
  "title": "Your Tutorial Title",
  "steps": [
    {
      "title": "Step Title",
      "content": "<p>HTML instructions — supports full HTML</p>",
      "checkpoint": "circuits/filename.dig"
    }
  ]
}
~~~

URL params: `tutorial.html?tutorial=my-tutorial.json&step=3`

## postMessage API (tutorial.html ↔ simulator iframe)

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
