# Implementation Plan: Harness Redesign

> Source spec: `docs/harness-redesign-spec.md` (24K tokens, do not load directly into implementer context).
> Per-wave specs are in `spec/wave-{n}-{name}.md` — each wave file is the implementer-facing phase spec.

## Phase 1 — Harness Redesign (only phase)

### Wave dependency graph

```
Wave 1 (types + interfaces)              [batch-1]
   ↓
Wave 2 (coordinator + facade + drain)    [batch-2]
   ↓
Wave 3 (comparison-session bulk)         [batch-3]
   ↓
Wave 4 (test migrations)  +  Wave 5 (MCP/UI surfaces)  +  Wave 6 (new tests)   [batch-4 — parallel]
```

Waves 1, 2, 3 are strictly sequential. Waves 4, 5, 6 run in parallel after Wave 3.

### Batch list

| Batch | Wave(s) | Task groups | Spec file |
|-------|---------|-------------|-----------|
| batch-1 | Wave 1 | W1 (types) | `spec/wave-1-types.md` |
| batch-2 | Wave 2 | W2 (coordinator+facade+engine) | `spec/wave-2-coordinator.md` |
| batch-3 | Wave 3 | W3 (comparison-session bulk) | `spec/wave-3-bulk.md` |
| batch-4 | Waves 4, 5, 6 in parallel | W4 (tests), W5 (surfaces), W6 (new tests) | `spec/wave-4-test-migrations.md`, `spec/wave-5-surfaces.md`, `spec/wave-6-new-tests.md` |

### Test command

`npm run test:q` — quiet vitest run, writes `test-results/test-failures.json`.
`npm test` — full vitest sweep with compact reporter.
`npm run test:e2e -- {filter}` — Playwright E2E tests.
`npx tsc --noEmit` — typecheck only.

### Verification measures (after all waves)

1. `npm run test:q` — full vitest sweep. Target: 12 → ≤4 failures (only known-BJT carry over).
2. `npm test -- harness` — focused harness module sweep.
3. `npm run test:e2e -- convergence-log-panel` — UI conflict notification test.
4. MCP harness end-to-end test — all `harness_*` modes including new `"shape"` mode.
5. `npx tsc --noEmit` — no type errors anywhere.

### Carry-over (already in working tree, do not redo)

- D1 `getDivergences` `withinTol` filter — already added in `comparison-session.ts:789-892`.
- D3 `traceNode` segment-match — already in `:1153-1156`, `_findNodeIdByLabel` at `:1629-1649`.
- Cat A `simTime` → `stepStartTime` rename in `compare.ts` and `query.ts`.
- Cat B/C `runDcOp` re-run path deletion + `analysisPhase === "tranFloat"` filter.
- Cat E minimal `detailedConvergence = true` + `limitingCollector = []` — Wave 3 supersedes.
- Cat F MCP handler serialization fixes.
- MCP-5 `getConvergenceDetail()` populated, MCP-7 NaN absDelta filter, MCP-12 stepIndex/iteration from args, MCP-15 delta computed.

### Vitest baseline entering Wave 1

12 failures (captured 2026-04-10):
- 1-4: BJT convergence (out of scope — known model divergence)
- 5: query-methods 41 "matrix NaN self-compare" — Wave 3 fixes via Goal F
- 6: query-methods 54 "traceNode self-compare 6 iters" — Wave 3
- 7: stream-verif 4 "ag0 on tranFloat" — Wave 3
- 8: stream-verif 5 "trapezoidal on tranFloat" — Wave 3
- 9: MCP-4 "integration coefficients on tranFloat" — Wave 3
- 10: MCP-5 "convergence detail per-element" — already fixed in Round 3, verify at Wave 3 exit
- 11-12: misc — verify at Wave 3 exit
