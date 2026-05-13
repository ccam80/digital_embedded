# digiTS

Browser-based digital logic circuit simulator. Purely static files, no server, no licensing dependencies.

## Hard Rules

### Engine-Agnostic Editor

The editor/renderer/interaction layer MUST be engine-agnostic:
- No simulation logic in canvas/editor code
- Simulation engine is a pluggable interface (start, stop, step, read/write signal values)
- Components do not declare an engine type- the unified compiler derives the simulation domain from each component's registered models
- Editor calls engine through the interface, never directly
- Components program against abstract `RenderContext` and engine interfaces, not Canvas2D or engine implementations

### Component Model Architecture

A component's `modelRegistry` may contain any number of models- behavioral, specific implementations (e.g. spice-l1/l2/l3), topology variants (e.g. open-collector vs push-pull, unipolar vs bipolar), digital models, or device-specific named presets. There is no required key set; the names are chosen to fit the component. The `defaultModel` property is ONLY meaningful for selecting the initial model in the property bag when a component is first placed. It has no semantic meaning beyond that- code that uses `defaultModel` as a lookup key at compile time, param merging, or model resolution is incorrect. The element's `model` property is the single source of truth after placement.

### Never Read .dig XML for Topology

**NEVER read .dig XML files directly to understand circuit topology.** The XML contains wire coordinates, pixel positions, and rendering metadata- none of which tells you what's connected to what. ALWAYS use the MCP circuit tools.

### Three-Surface Testing Rule

**Every user-facing feature MUST be tested across all three surfaces:**

1. **Headless API test** (`src/**/__tests__/*.test.ts`)- Import `DefaultSimulatorFacade`, call methods directly. Validates core logic without any transport layer.

2. **MCP tool test** (`src/**/__tests__/*.test.ts`)- Exercise via MCP server tool handlers. Validates agent-facing contract: serialization, handle management, error formatting.

3. **E2E / UI test** (`e2e/**/*.spec.ts`)- Playwright browser tests. For postMessage features, use `SimulatorHarness` (`e2e/fixtures/simulator-harness.ts`). Validates full stack: DOM, events, wire protocol.

A feature can work headless but break in MCP serialization, or work in MCP but fail in the browser. All three surfaces are non-negotiable.

### Component Test Authoring

Authoring or migrating an analog component test (Surface 1, headless API) goes through the canonical reference set:

- `docs/api-reference/test-tools.md` — picks the tier (T1 `buildFixture`, T2 `ComparisonSession.createSelfCompare`, T3 `ComparisonSession.create` + MCP `harness_*`), the canonical category (1–9), and the worked code template. Also lists the banned patterns (engine-impersonator constructions, private-field tunnelling, slot-index access bypassing the schema, etc.).
- `docs/api-reference/engine-flow.md` — what's observable at each step boundary and what is harness-only. Read this before asserting on any internal state.

Do not assemble a `LoadContext` / `SetupContext` / `StatePool` by hand, do not call `element.setup()` / `element.load()` directly, do not import `SLOT_*` constants — every sanctioned access pattern is in those two docs.

### No Pragmatic Patches

Never propose "pragmatic", "simple", "fastest", or "minimal" solutions. Always implement the cleanest final architecture. If the correct fix requires interface changes, larger blast radius, or new infrastructure- do that work. Never defer the real fix until later.

### SPICE-Correct Implementations Only

When implementing or fixing any SPICE-derived algorithm (convergence, stamps, limiting, integration), match the corresponding ngspice source function exactly (e.g., `BJTconvTest`, `DIOload`). Provide a mapping table from ngspice variables to ours.

### Sparse Solver is Settled- Do Not Re-Investigate

**Matrix ordering, Markowitz tie-break, and pivoting inside `src/solver/analog/sparse-solver.ts` are bit-identical to ngspice's `spMatrix` (Sparse 1.3a)** and have been verified by multiple prior investigations against `ref/ngspice/src/spicelib/sparse/*.c`. When you see a 1-ULP parity divergence after a bit-identical matrix + RHS at iter 0, the divergence is **not** in `spOrderAndFactor` / `spFactor` / `spSolve` and not in the per-bucket setup walk that feeds them.

Look further upstream instead:
- per-device `load()` accumulation order on a shared diagonal (multiple stamps `+=` into the same cell — order matters in floating point);
- per-device `setup()` TSTALLOC sequence vs the corresponding `ref/ngspice/src/spicelib/devices/<dev>/<dev>setup.c` lines (a swapped pair of allocElement calls changes the matrix internal element-pool order and is structurally visible at the harness CSC dump);
- composite-internal node-ID allocation order in `expandCompositeInstance` (compiler.ts) vs ngspice INPpas2 / INPtermInsert first-encounter order along the emitted deck.

Do not re-derive Markowitz, do not add LU logging to "see if pivoting differs," do not propose rewriting the sparse solver as a fix path. If a fresh investigation conclusively contradicts this directive (with an evidenced diff against `ref/ngspice/src/spicelib/sparse/`), escalate — do not flip the directive silently.

### ngspice Parity Vocabulary- Banned Closing Verdicts

When comparing digiTS against ngspice, the following words are banned as closing verdicts on any divergence:

- *mapping* / *mapping table*- if you need one to declare equivalence, the item is architectural, not numerical
- *tolerance* / *within tolerance* / *close enough*- strict bit-exact is the bar; if you can't meet it, escalate
- *equivalent to* / *equivalent under*- if they're truly equivalent, they match bit-exact; otherwise they're not equivalent
- *pre-existing* / *pre-existing failure*- an item being old does not make it acceptable
- *intentional divergence*- every accepted divergence is an item in `spec/architectural-alignment.md`, not an in-line justification
- *citation divergence* / *documentation hygiene* (used to close a numerical gap)- if the cited ngspice file differs from code behavior, either the code or the citation is wrong; neither is a doc-cleanup task
- *partial* as a closing verdict on a parity item

**Remedy when you would have used one of these words:** STOP and escalate. The item belongs in `spec/architectural-alignment.md` (architectural divergence) or `spec/fix-list-phase-2-audit.md` (numerical bug). Agents do not add items to `architectural-alignment.md`- that is a user action. Your escalation report includes: the cited ngspice file, the digiTS file, the specific quantities that differ, why you think it's architectural rather than numerical, and the user prompt needed to resolve it.

Rationale: these words, used as closing verdicts, raised the tolerance floor across the project and sheltered real numerical bugs. Banning them at the vocabulary level prevents the drift.

### ngspice Comparison Harness- First Tool for Numerical Issues

For ANY numerical discrepancy, convergence failure, or model correctness question, the **first step** is to compare per-NR-iteration internal node/branch values against ngspice using the harness MCP tools. Do not theorize about code differences, do not write `.mjs` probe scripts that copy values out of tool responses- the harness tools answer "where did this first go wrong" directly.

**Triage path (use this order, do not skip steps):**

1. `harness_start`- create a session against a `.dts` or `.dig` circuit; the session wraps both digiTS and the instrumented ngspice DLL. Structural-parity asserts are deferred on the MCP path, so `harness_run` never short-circuits even on circuits with matrix-size or coord-set divergence — investigation always proceeds.
2. `harness_run`- execute the analysis (DC-OP or transient).
3. **`harness_first_divergence`** - returns the earliest divergence in each of four signal classes (voltage / matrix / state / shape) plus `earliest` across all four. ALWAYS call this first after `harness_run`. Picks the axis you need to drill into.
4. **`harness_topology_diff`** - returns elements present on one side but not the other, nodes/branches where the matched 1-based slot index differs between sides ("allocated in a different order"), unmapped ngspice nodes, and deferred messages from the structural-parity asserts. Call this when `firstDivergence.matrix` or `firstDivergence.shape` is non-null, or when `harness_run` reports any error.
5. **`harness_matrix_diff`** - returns the verdict at one reference iteration (`match` / `value-only` / `value-permutation` / `coord-set-differs`), plus `oursOnly` / `ngspiceOnly` / `valueMismatches` cell lists with `firstDivergentStep` / `firstDivergentIteration` attached. Call this when `firstDivergence.matrix` is non-null. The per-cell `firstDivergentStep` tells you which step a specific Jacobian cell first went off — no need to scan steps yourself.
6. `harness_get_attempt` (with `nodes` / `component` slice) - zoom in on the concrete (step, iter) the diff tools pointed at, sliced to the divergent rows/cols. This is the read-the-actual-numbers step; do not start here.
7. `harness_get_step` / `harness_session_map` / `harness_export` - per-step summaries, shape, full-session dump for offline analysis.
8. `harness_describe` - full topology metadata when you need pins-and-slots detail.
9. `harness_dispose` - release resources when done.

**Anti-patterns to avoid:**
- Calling `harness_get_attempt` before the diff tools. The dense matrix dump is a zoom-in surface, not triage. If you don't already know which (row, col) cells diverge, the diff tools tell you in one call.
- Copying numbers out of tool responses into `.mjs` probe scripts to compute deltas or first-divergent-step yourself — the diff tools already do this server-side.
- Treating a `harness_run` error message as the whole answer. The matching `structuralFindings[]` (returned by `harness_topology_diff`) carries the same message in a machine-readable form alongside the rest of the diff data.

The harness is the only sanctioned route to per-iteration / per-element-state / matrix data; do not reach into engine internals from tests or specs to do this work yourself.

### Serve Over HTTP

All files MUST be served over HTTP, not opened as `file://` URLs.

## Working with Circuits (MCP Tools)

The circuit simulator MCP server keeps circuits in memory across tool calls. Load once, then inspect/patch/compile without re-parsing.

**Discovery workflow:** `circuit_list` → `circuit_describe` → `circuit_build`

**Edit workflow:** `circuit_load` → `circuit_netlist` → `circuit_patch` → `circuit_validate` → `circuit_compile`

### Addressing Scheme

Read format equals write format- netlist addresses are patch targets.

| Target | Format | Example |
|--------|--------|---------|
| Component | `"label"` or `"instanceId"` | `"gate1"` |
| Pin | `"label:pinLabel"` | `"gate:A"` |
| Subcircuit | `"parent/child"` prefix | `"cpu/alu:A"` |

All other API details (facade methods, patch ops, CircuitSpec format, component properties, diagnostic codes) are discoverable via `circuit_describe`, `circuit_validate`, and reading `src/headless/facade.ts` or `src/headless/netlist-types.ts`.

## Headless Architecture

All programmatic access goes through `DefaultSimulatorFacade` (`src/headless/default-facade.ts`)- the single unified entry point. It composes `CircuitBuilder` (build/patch), `SimulationLoader` (load .dig/.json), and delegates test execution to `TestRunner`. Fresh engine per `compile()`.

Consumers: MCP server (`scripts/circuit-mcp-server.ts`), postMessage adapter (`src/io/postmessage-adapter.ts`), app-init (`src/app/app-init.ts`), tests.

## postMessage API

All handling centralized in `src/io/postmessage-adapter.ts` (single source of truth). All messages use `sim-` prefix.

~~~
Parent → iframe (core):
  sim-load-url, sim-load-data, sim-load-json   - Load circuits
  sim-set-signal, sim-step, sim-read-signal     - Drive simulation
  sim-read-all-signals                          - Snapshot all signals
  sim-run-tests                                 - Run test vectors
  sim-get-circuit                               - Export as base64
  sim-set-base, sim-set-locked                  - Configuration
  sim-load-memory, sim-set-palette              - Memory/palette control
  sim-import-subcircuit                         - Import subcircuit definition

Parent → iframe (tutorial):
  sim-test                                      - Test vectors with label validation
  sim-highlight, sim-clear-highlight            - Visual feedback
  sim-set-readonly-components                   - Lock components
  sim-set-instructions                          - Show/hide instructions

Iframe → parent:
  sim-ready, sim-loaded, sim-error              - Lifecycle
  sim-test-result                               - Test results (passed, failed, total, details)
  sim-output, sim-signals                       - Signal reads
  sim-circuit-data                              - Circuit export
  sim-subcircuit-imported                       - Subcircuit import result
~~~

Full message schemas with all fields: read `src/io/postmessage-adapter.ts`.

## Tutorial System

Authoring workflow:
1. `tutorial_list_presets`- pick palette presets
2. `circuit_build` + `circuit_test`- develop and verify goal circuits
3. Assemble a `TutorialManifest` (schema in `src/app/tutorial/types.ts`)
4. `tutorial_validate`- check for errors
5. `tutorial_create`- generate package (manifest.json + .dig files)

## Tests

| Command | Purpose |
|---------|---------|
| `npm run test:q` | **Agent default.** Quiet mode- summary + `test-results/test-failures.json` |
| `npm test` | All tests, compact reporter |
| `npm run test:watch` | Vitest watch mode (unit/integration only) |

- Unit/integration: Vitest- `src/**/__tests__/*.test.ts`
- E2E: Playwright- `e2e/gui/` (browser interaction), `e2e/parity/` (postMessage API)
- E2E harness: `SimulatorHarness` in `e2e/fixtures/simulator-harness.ts`
- **Diagnosing engine crashes/stagnation**: Enable the convergence log (UI: Analysis → Convergence Log → Enable; MCP: `circuit_convergence_log { action: "enable" }`; headless: `coordinator.setConvergenceLogEnabled(true)`) BEFORE running the simulation, then inspect per-step records to identify the blame element and dt collapse pattern.
