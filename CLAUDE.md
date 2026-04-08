# digiTS

Browser-based digital logic circuit simulator. Purely static files, no server, no licensing dependencies.

## Hard Rules

### Engine-Agnostic Editor

The editor/renderer/interaction layer MUST be engine-agnostic:
- No simulation logic in canvas/editor code
- Simulation engine is a pluggable interface (start, stop, step, read/write signal values)
- Components do not declare an engine type — the unified compiler derives the simulation domain from each component's registered models
- Editor calls engine through the interface, never directly
- Components program against abstract `RenderContext` and engine interfaces, not Canvas2D or engine implementations

### Component Model Architecture

A fully implemented component has these models: digital, and a modelRegistry containing behavioral, spice-l1, spice-l2, spice-l3, plus device-specific named models. Some components will be missing a subset; this should be considered incomplete implementation, not a design choice. The `defaultModel` property is ONLY meaningful for selecting the initial model in the property bag when a component is first placed. It has no semantic meaning beyond that — code that uses `defaultModel` as a lookup key at compile time, param merging, or model resolution is incorrect. The element's `model` property is the single source of truth after placement.

### Never Read .dig XML for Topology

**NEVER read .dig XML files directly to understand circuit topology.** The XML contains wire coordinates, pixel positions, and rendering metadata — none of which tells you what's connected to what. ALWAYS use the MCP circuit tools.

### Three-Surface Testing Rule

**Every user-facing feature MUST be tested across all three surfaces:**

1. **Headless API test** (`src/**/__tests__/*.test.ts`) — Import `DefaultSimulatorFacade`, call methods directly. Validates core logic without any transport layer.

2. **MCP tool test** (`src/**/__tests__/*.test.ts`) — Exercise via MCP server tool handlers. Validates agent-facing contract: serialization, handle management, error formatting.

3. **E2E / UI test** (`e2e/**/*.spec.ts`) — Playwright browser tests. For postMessage features, use `SimulatorHarness` (`e2e/fixtures/simulator-harness.ts`). Validates full stack: DOM, events, wire protocol.

A feature can work headless but break in MCP serialization, or work in MCP but fail in the browser. All three surfaces are non-negotiable.

### No Pragmatic Patches

Never propose "pragmatic", "simple", "fastest", or "minimal" solutions. Always implement the cleanest final architecture. If the correct fix requires interface changes, larger blast radius, or new infrastructure — do that work. Never defer the real fix until later.

### SPICE-Correct Implementations Only

When implementing or fixing any SPICE-derived algorithm (convergence, stamps, limiting, integration), match the corresponding ngspice source function exactly (e.g., `BJTconvTest`, `DIOload`). Provide a mapping table from ngspice variables to ours.

### ngspice Comparison Harness — First Tool for Numerical Issues

For ANY numerical discrepancy, convergence failure, or model correctness question, the **first step** is to compare per-NR-iteration internal node/branch values against ngspice using the instrumented test harness. Do not theorize about code differences — run the comparison and find the exact iteration where values diverge. See `docs/ngspice-harness-howto.md` for setup and usage. The harness captures per-iteration voltages, device states (`CKTstate0`), and convergence data from both engines side-by-side.

### Serve Over HTTP

All files MUST be served over HTTP, not opened as `file://` URLs.

## Working with Circuits (MCP Tools)

The circuit simulator MCP server keeps circuits in memory across tool calls. Load once, then inspect/patch/compile without re-parsing.

**Discovery workflow:** `circuit_list` → `circuit_describe` → `circuit_build`

**Edit workflow:** `circuit_load` → `circuit_netlist` → `circuit_patch` → `circuit_validate` → `circuit_compile`

### Addressing Scheme

Read format equals write format — netlist addresses are patch targets.

| Target | Format | Example |
|--------|--------|---------|
| Component | `"label"` or `"instanceId"` | `"gate1"` |
| Pin | `"label:pinLabel"` | `"gate:A"` |
| Subcircuit | `"parent/child"` prefix | `"cpu/alu:A"` |

All other API details (facade methods, patch ops, CircuitSpec format, component properties, diagnostic codes) are discoverable via `circuit_describe`, `circuit_validate`, and reading `src/headless/facade.ts` or `src/headless/netlist-types.ts`.

## Headless Architecture

All programmatic access goes through `DefaultSimulatorFacade` (`src/headless/default-facade.ts`) — the single unified entry point. It composes `CircuitBuilder` (build/patch), `SimulationLoader` (load .dig/.json), and delegates test execution to `TestRunner`. Fresh engine per `compile()`.

Consumers: MCP server (`scripts/circuit-mcp-server.ts`), postMessage adapter (`src/io/postmessage-adapter.ts`), app-init (`src/app/app-init.ts`), tests.

## postMessage API

All handling centralized in `src/io/postmessage-adapter.ts` (single source of truth). All messages use `sim-` prefix.

~~~
Parent → iframe (core):
  sim-load-url, sim-load-data, sim-load-json    — Load circuits
  sim-set-signal, sim-step, sim-read-signal      — Drive simulation
  sim-read-all-signals                           — Snapshot all signals
  sim-run-tests                                  — Run test vectors
  sim-get-circuit                                — Export as base64
  sim-set-base, sim-set-locked                   — Configuration
  sim-load-memory, sim-set-palette               — Memory/palette control
  sim-import-subcircuit                          — Import subcircuit definition

Parent → iframe (tutorial):
  sim-test                                       — Test vectors with label validation
  sim-highlight, sim-clear-highlight             — Visual feedback
  sim-set-readonly-components                    — Lock components
  sim-set-instructions                           — Show/hide instructions

Iframe → parent:
  sim-ready, sim-loaded, sim-error               — Lifecycle
  sim-test-result                                — Test results (passed, failed, total, details)
  sim-output, sim-signals                        — Signal reads
  sim-circuit-data                               — Circuit export
  sim-subcircuit-imported                        — Subcircuit import result
~~~

Full message schemas with all fields: read `src/io/postmessage-adapter.ts`.

## Tutorial System

Authoring workflow:
1. `tutorial_list_presets` — pick palette presets
2. `circuit_build` + `circuit_test` — develop and verify goal circuits
3. Assemble a `TutorialManifest` (schema in `src/app/tutorial/types.ts`)
4. `tutorial_validate` — check for errors
5. `tutorial_create` — generate package (manifest.json + .dig files)

## Tests

| Command | Purpose |
|---------|---------|
| `npm run test:q` | **Agent default.** Quiet mode — summary + `test-results/test-failures.json` |
| `npm test` | All tests, compact reporter |
| `npm run test:watch` | Vitest watch mode (unit/integration only) |

- Unit/integration: Vitest — `src/**/__tests__/*.test.ts`
- E2E: Playwright — `e2e/gui/` (browser interaction), `e2e/parity/` (postMessage API)
- E2E harness: `SimulatorHarness` in `e2e/fixtures/simulator-harness.ts`
- **Diagnosing engine crashes/stagnation**: Enable the convergence log (UI: Analysis → Convergence Log → Enable; MCP: `circuit_convergence_log { action: "enable" }`; headless: `coordinator.setConvergenceLogEnabled(true)`) BEFORE running the simulation, then inspect per-step records to identify the blame element and dt collapse pattern.
