# Digital-in-Browser

## Project Overview

A browser-based digital logic circuit simulator for embedding in university course tutorials. The project is a **native TypeScript port of [hneemann/Digital](https://github.com/hneemann/Digital)** — purely static files, no server, no licensing dependencies.

**For all design and planning work, read `spec/plan.md` first.** It defines phases, tasks, dependencies, performance architecture, and verification criteria.

**Before writing any code, read `spec/author_instructions.md`.** It defines the TS idiom guide, priority order (architectural consistency > performance > ease), review checkpoints, and the component implementation template.

## Current State

Phase 0 (dead code removal) is complete. All legacy prototype artifacts have been removed. No native TS code has been written yet.

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
| .dig XML format | Any `.dig` file + Digital's XML serialization annotations |
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
Parent → iframe (core):
  { type: 'digital-load-url', url: '<url>' }          — Load a .dig circuit file
  { type: 'digital-load-data', data: '<base64>' }     — Load inline circuit data (base64 .dig XML)
  { type: 'digital-set-base', basePath: '<path>' }    — Set HTTP base path for file resolution
  { type: 'digital-set-locked', locked: true|false }  — Lock/unlock editor
  { type: 'digital-set-palette', components: [...] }  — Restrict palette to listed types (null = show all)

Parent → iframe (tutorial):
  { type: 'digital-test', testData: '<test vectors>' }              — Run test vectors, get results back
  { type: 'digital-get-circuit' }                                    — Export current circuit as base64
  { type: 'digital-highlight', labels: [...], duration?: ms }       — Highlight components by label
  { type: 'digital-clear-highlight' }                                — Clear all highlights
  { type: 'digital-set-readonly-components', labels: [...] | null } — Lock specific components
  { type: 'digital-set-instructions', markdown: '...' | null }      — Show/hide instructions panel

Iframe → parent:
  { type: 'digital-ready' }                        — Simulator initialized
  { type: 'digital-loaded' }                       — Circuit/setting applied
  { type: 'digital-error', error: '...' }          — Error occurred
  { type: 'digital-test-result', passed, failed, total, details: [...] }  — Test results
  { type: 'digital-circuit-data', data: '<base64>', format: 'dig-xml-base64' }  — Circuit export
~~~

## Tutorial System

Structured tutorial authoring and runtime for step-by-step circuit-building exercises.

### Key Files

| File | Purpose |
|------|---------|
| `src/tutorial/types.ts` | Tutorial data model — `TutorialManifest`, `TutorialStep`, type guards |
| `src/tutorial/validate.ts` | Manifest validation against registry |
| `src/tutorial/presets.ts` | Named palette presets (`basic-gates`, `sequential-intro`, etc.) |
| `src/tutorial/tutorial-host.ts` | Tutorial host page manager |

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
3. Assemble a `TutorialManifest` JSON (see template in `src/tutorial/types.ts`)
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

## Agent Circuit API (Headless Facade)

A string-addressed facade for LLM agents to inspect and modify circuits without touching wire coordinates or object references.

### CRITICAL: How to Work with Circuits

**NEVER read .dig XML files directly to understand circuit topology.** The XML contains wire coordinates, pixel positions, and rendering metadata — none of which tells you what's connected to what. Reading XML to debug a circuit is like reading a bitmap to understand a spreadsheet.

**ALWAYS use the MCP circuit tools.** The circuit simulator MCP server (`scripts/circuit-mcp-server.ts`) keeps circuits in memory across tool calls. Load once, then inspect/patch/compile without re-parsing.

**MCP tools:**

| Tool | Input | Output |
|------|-------|--------|
| `circuit_list` | `{ category? }` | All component types grouped by category |
| `circuit_describe` | `{ typeName }` | Pin layout, properties (with descriptions, min/max), help text |
| `circuit_load` | `{ path }` | Handle + summary |
| `circuit_netlist` | `{ handle }` | Components, nets with connectivity, diagnostics |
| `circuit_validate` | `{ handle }` | Diagnostics only |
| `circuit_patch` | `{ handle, ops, scope? }` | Post-patch diagnostics |
| `circuit_build` | `{ spec }` | Handle + diagnostics |
| `circuit_compile` | `{ handle }` | Success or structured errors |
| `circuit_test` | `{ handle, testData? }` | Pass/fail results |
| `circuit_save` | `{ handle, path }` | Confirmation |

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

If `netlist()` reports `sysreg:ADD [1-bit]`, the patch target is `{ op: 'set', target: 'ADD', props: { Bits: 16 } }`.

### Introspection Methods

- `netlist(circuit)` — returns `Netlist` with components, nets (all connected pins per net), and diagnostics
- `validate(circuit)` — returns `Diagnostic[]`; convenience wrapper for `netlist().diagnostics`
- `describeComponent(typeName)` — queries registry for pin layout and configurable properties

### Editing Methods

- `build(spec)` — create a circuit from a declarative `CircuitSpec` (no coordinates required)
- `patch(circuit, ops, opts?)` — apply one or more `PatchOp` edits using label:pin addressing; returns updated diagnostics

### Patch Operations

| Op | Target | Purpose | Example |
|----|--------|---------|---------|
| `set` | component label | Change properties | `{"op":"set","target":"ADD","props":{"Bits":16}}` |
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

**Property keys** use internal names from `circuit_describe`, not XML attribute names. Common ones:

| Property | Type | Used by | Purpose |
|----------|------|---------|---------|
| `label` | STRING | most types | Display label |
| `bitWidth` | BIT_WIDTH | gates, arithmetic | Signal width (1–32) |
| `inputCount` | INT | gates | Number of inputs (2–5) |
| `_inverterLabels` | STRING | gates | Invert specific inputs: `"1,3"` or `"In_1,In_3"` |
| `Bits` | BIT_WIDTH | In, Out, memory | Signal width |
| `defaultValue` | INT | In, Const | Initial value |

**Connections** are pairs of `"id:pinLabel"` strings. Pin labels must match the component type's declared pins exactly. Use `circuit_describe({ typeName: "..." })` to look up pin labels before connecting.

**Example** — 2-input AND gate with labeled I/O:

~~~json
{
  "components": [
    { "id": "A",    "type": "In",  "props": { "label": "A", "Bits": 1 } },
    { "id": "B",    "type": "In",  "props": { "label": "B", "Bits": 1 } },
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
| `src/headless/facade.ts` | `SimulatorFacade` interface |
| `src/headless/netlist-types.ts` | `Netlist`, `Diagnostic`, `CircuitSpec`, `PatchOp` types |
| `src/headless/netlist.ts` | `resolveNets()` implementation |
| `src/headless/address.ts` | Address resolution utilities |
| `src/headless/builder.ts` | `CircuitBuilder` with `build()` and `patch()` |
| `src/headless/auto-layout.ts` | Sugiyama-style auto-layout engine for `build()` |
| `src/headless/types.ts` | `FacadeError`, `TestResults` |
| `src/headless/index.ts` | Public API exports |

### Design Principles

- **Never read .dig XML for topology** — use `circuit_netlist` / `circuit_validate` MCP tools
- **Same vocabulary for read and write** — netlist addresses = patch targets
- **Validate after every edit** — `patch()` returns diagnostics automatically
- **No object references** — everything is string-addressed for LLM compatibility
- **Diagnostics, not exceptions** — `validate()` collects all issues instead of throwing on the first
