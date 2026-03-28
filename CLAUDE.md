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

### Never Read .dig XML for Topology

**NEVER read .dig XML files directly to understand circuit topology.** The XML contains wire coordinates, pixel positions, and rendering metadata — none of which tells you what's connected to what. ALWAYS use the MCP circuit tools.

### Three-Surface Testing Rule

**Every user-facing feature MUST be tested across all three surfaces:**

1. **Headless API test** (`src/**/__tests__/*.test.ts`) — Import `DefaultSimulatorFacade`, call methods directly. Validates core logic without any transport layer.

2. **MCP tool test** (`src/**/__tests__/*.test.ts`) — Exercise via MCP server tool handlers. Validates agent-facing contract: serialization, handle management, error formatting.

3. **E2E / UI test** (`e2e/**/*.spec.ts`) — Playwright browser tests. For postMessage features, use `SimulatorHarness` (`e2e/fixtures/simulator-harness.ts`). Validates full stack: DOM, events, wire protocol.

A feature can work headless but break in MCP serialization, or work in MCP but fail in the browser. All three surfaces are non-negotiable.

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
  sim-set-input, sim-step, sim-read-output       — Drive simulation
  sim-read-all-signals                           — Snapshot all signals
  sim-run-tests                                  — Run test vectors
  sim-get-circuit                                — Export as base64
  sim-set-base, sim-set-locked                   — Configuration
  sim-load-memory, sim-set-palette               — Memory/palette control

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
