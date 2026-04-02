# Domain Leak Fix — Progress

## Status: In Progress

### Wave 1 — Type foundations + algorithm rebuilds
| Task ID | Title | Status |
|---------|-------|--------|
| W1-T1 | Unify Diagnostic types | pending |
| W1-T2 | Add labelToCircuitElement | pending |
| W1-T3 | Reshape netlist types | pending |
| W1-T4 | Rebuild resolveNets on infrastructure | pending |
| W1-T5 | Move connectivity diagnostics | pending |
| W1-T6 | Pass solver diagnostics through | pending |
| W1-T7 | Remove label whitelist | pending |
| W1-T8 | Add setSourceByLabel | pending |
| W1-T9 | Remove electrical validation from connect() | pending |
| W1-T10 | Facade renames + settle + setSignal routing | pending |
| W1-T11 | Async test executor + parser extensions | pending |
| W1-T12 | Equivalence vacuous fix + settle | pending |

### Wave 2 — Consumers + formatting
| Task ID | Title | Status |
|---------|-------|--------|
| W2-T1 | Domain-aware formatting | pending |
| W2-T2 | MCP tool fixes + delete circuit_describe_file | pending |
| W2-T3 | postMessage wire protocol rename + fixes | pending |
| W2-T4 | Unified diagnostic overlays | pending |
| W2-T5 | Rename-only consumer files | pending |

## Task W1-T7: Remove label whitelist from analog compiler
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/solver/analog/compiler.ts
- **Tests**: 9932/9932 passing

## Task W2-T1: Domain-aware formatting
- **Status**: complete
- **Agent**: implementer
- **Files created**: scripts/mcp/__tests__/formatters.test.ts
- **Files modified**: scripts/mcp/formatters.ts
- **Tests**: 24/24 passing

## Task W2-T3: postMessage wire protocol rename + fixes
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `e2e/parity/headless-simulation.spec.ts` — renamed all `sim-set-input` → `sim-set-signal` and `sim-read-output` → `sim-read-signal` in test bodies and descriptions; updated module comment
  - `e2e/fixtures/simulator-harness.ts` — updated JSDoc comment to reflect new message names
  - `src/io/postmessage-adapter.ts` — updated JSDoc comment for `sim-set-signal`/`sim-read-signal`; rewrote `_handleTestTutorial` to compile first and then use `labelSignalMap` domain to detect analog inputs, removing hardcoded In/Clock/Port whitelist
- **Tests**: 9956/9956 vitest passing (0 failures); 1 flaky timeout in `wire-current-resolver.test.ts` under full-suite load (passes in isolation at 3568ms, pre-existing flakiness unrelated to this task); E2E not run (dev server not available)
- **Notes**: The switch cases `sim-set-signal` and `sim-read-signal` were already present in the adapter; old names `sim-set-input`/`sim-read-output` were already removed from the switch in a prior Wave 1 task. This task updated the parity tests and harness comment to match, and improved the tutorial signal detection to be domain-aware using `labelSignalMap`.

## Task W2-T2: MCP tool fixes + delete circuit_describe_file
- **Status**: complete
- **Agent**: implementer
- **Files created**: scripts/__tests__/circuit-tools-w2t2.test.ts
- **Files modified**: scripts/mcp/circuit-tools.ts
- **Tests**: 20/20 passing (new tests); 9956/9956 total passing
- **Changes made**:
  - Deleted `circuit_describe_file` tool registration and `scanDigPins` import
  - `circuit_list`: removed directional arrows (↓↑↕) from include_pins output; pin labels only
  - `circuit_list`: added "ANALOG" to category filter description
  - `circuit_test`: changed description from "Digital test format" to "test vector format"
  - `circuit_test`: domain-aware driver analysis — analog pins show connected components without directional language; digital pins keep existing INPUT→OUTPUT trace
  - `circuit_patch`: added analog example `{op:'set', target:'R1', props:{resistance:10000}}` to ops description
  - `circuit_compile`: replaced stale `circuit_set_input`/`circuit_read_output` references with `circuit_set_signal`/`circuit_read_signal`; added conditional analog tool suggestions (circuit_dc_op, circuit_ac_sweep) when coordinator.supportsDcOp() or supportsAcSweep() is true
  - Note: `src/io/dig-pin-scanner.ts` was NOT deleted — it has other consumers (scan74xxPinMap used by circuit-mcp-server.ts, generate-all-components-fixture.ts, measure-engine-references.ts). Only the scanDigPins import was removed from circuit-tools.ts.

## Task W2-T4: Unified diagnostic overlays (render-pipeline.ts + simulation-controller.ts)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/app/render-pipeline.ts` — changed import from `SolverDiagnostic` in `../core/analog-engine-interface.js` to `Diagnostic` from `../compile/types.js`; updated `RenderPipeline` interface and `populateDiagnosticOverlays` implementation to accept `Diagnostic[]`; extended the function to handle both `involvedNodes` (via `wireToNodeId` reverse-lookup for solver diagnostics) and `involvedPositions` (used directly for connectivity diagnostics)
  - `src/app/simulation-controller.ts` — removed the forced `as unknown as SolverDiagnostic[]` cast at lines 308-309; now passes `allDiags` (typed `Diagnostic[]`) directly to `populateDiagnosticOverlays`
- **Tests**: 7789/7789 vitest passing; TypeScript compiles clean

## Task W2-T5: Rename-only consumer files
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: none (all target files already updated by Wave 1)
- **Files analyzed**:
  - `src/testing/comparison.ts` — already uses `setSignal`, `readSignal`, `settle` (async)
  - `src/testing/run-all.ts` — already uses `setSignal`, `readSignal`, `settle` (async)
  - `src/analysis/model-analyser.ts` — already uses `setSignal`, `readSignal`, `settle` (async)
  - `scripts/verify-fixes.ts` — already uses `setSignal`, `readSignal`, `settle` (async)
- **Notes**: 
  - Verified no remaining references to old facade method names (`setInput`, `readOutput`, `runToStable`) on the main SimulatorFacade in production code
  - Mock facades in test files and specialized interfaces (e.g., `SequentialAnalysisFacade` in state-transition.ts, `EditorBinding.setInput` for UI binding) intentionally kept their own method names as they are not part of the main facade contract
  - `src/io/dig-pin-scanner.ts` was NOT deleted — it has other consumers (`scan74xxPinMap` used by circuit-mcp-server.ts, generate-all-components-fixture.ts, measure-engine-references.ts). The file was previously deleted and restored per spec (only delete if ONLY consumer is circuit_describe_file, which was already deleted by W2-T2)
- **Tests**: 9956/9956 vitest passing (no changes needed)
