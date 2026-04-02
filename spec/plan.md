# Domain Leak Fix — Implementation Plan

## Phase 1: Domain Leak Fix

Single phase, two waves. Spec: `spec/domain-leak-fix.md`.

### Dependency Graph

```
Phase 1 (Domain Leak Fix)
  └─ Wave 1 (Type foundations + algorithm rebuilds) → Wave 2 (Consumers + formatting)
```

### Wave 1 — Type foundations + algorithm rebuilds (all parallel)

| Task ID | Title | Complexity | Files |
|---------|-------|------------|-------|
| W1-T1 | Unify Diagnostic types | L | `src/compile/types.ts`, `src/core/analog-types.ts`, `src/core/analog-engine-interface.ts`, `src/solver/analog/diagnostics.ts`, `src/compile/compile.ts`, tests |
| W1-T2 | Add labelToCircuitElement | S | `src/compile/types.ts`, `src/compile/compile.ts` |
| W1-T3 | Reshape netlist types | M | `src/headless/netlist-types.ts` |
| W1-T4 | Rebuild resolveNets on infrastructure | L | `src/headless/netlist.ts` |
| W1-T5 | Move connectivity diagnostics | M | `src/compile/extract-connectivity.ts` |
| W1-T6 | Pass solver diagnostics through | S | `src/compile/compile.ts` |
| W1-T7 | Remove label whitelist | S | `src/solver/analog/compiler.ts` |
| W1-T8 | Add setSourceByLabel | M | `src/solver/coordinator.ts`, `src/solver/coordinator-types.ts` |
| W1-T9 | Remove electrical validation from connect() | S | `src/headless/builder.ts`, `src/headless/facade.ts` |
| W1-T10 | Facade renames + settle + setSignal routing | L | `src/headless/facade.ts`, `src/headless/default-facade.ts` |
| W1-T11 | Async test executor + parser extensions | L | `src/testing/executor.ts`, `src/testing/parser.ts` |
| W1-T12 | Equivalence vacuous fix + settle | S | `src/headless/equivalence.ts` |

### Wave 2 — Consumers + formatting (all parallel, after Wave 1)

| Task ID | Title | Complexity | Files |
|---------|-------|------------|-------|
| W2-T1 | Domain-aware formatting | M | `scripts/mcp/formatters.ts` |
| W2-T2 | MCP tool fixes + delete circuit_describe_file | M | `scripts/mcp/circuit-tools.ts`, `src/io/dig-pin-scanner.ts` |
| W2-T3 | postMessage wire protocol rename + fixes | M | `src/io/postmessage-adapter.ts` |
| W2-T4 | Unified diagnostic overlays | M | `src/app/render-pipeline.ts`, `src/app/simulation-controller.ts` |
| W2-T5 | Rename-only consumer files | S | `src/testing/comparison.ts`, `src/testing/run-all.ts`, `src/analysis/model-analyser.ts`, `scripts/verify-fixes.ts`, test files |

### Verification Measures

- `npm run test:q` passes after each wave
- No remaining references to `SolverDiagnostic`, `setInput`, `readOutput`, `runToStable`, `availableModels`, `activeModel`, `circuit_describe_file`
- All `Diagnostic` consumers use unified type from `compile/types.ts`
