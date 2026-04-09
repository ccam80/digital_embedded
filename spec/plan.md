# Harness Streams Implementation Plan

## Spec Files

- Phase 1: `docs/specs/harness-stream1-data-accuracy.md`
- Phase 2: `docs/specs/harness-stream3-interface-methods.md`
- Phase 3: `docs/specs/harness-stream2-mcp-tooling.md`

## Phase Dependency Graph

```
Phase 1 (Stream 1: Data Accuracy) → Phase 2 (Stream 3: Interface Methods) → Phase 3 (Stream 2: MCP Tooling)
```

## Phases and Waves

### Phase 1: Stream 1 — Data Completeness and Accuracy

Spec: `docs/specs/harness-stream1-data-accuracy.md`

16 items covering type extensions, engine instrumentation, capture enhancements, ngspice bridge updates, and C callback struct redesign.

#### Wave 1.1 (parallel — independent files, no overlap)

| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| S1-A | BJT companion mapping (Item 5) + Netlist generator (Item 12) | M | `src/solver/analog/__tests__/harness/device-mappings.ts`, `src/solver/analog/__tests__/harness/netlist-generator.ts` (new) |
| S1-B | comparison-session.ts fixes: DC OP doc (Item 13) + __dirname fix (Item 14) | S | `src/solver/analog/__tests__/harness/comparison-session.ts` |
| S1-C | Engine instrumentation: pre-solve RHS (Item 6 sparse-solver), checkAllConvergedDetailed (Item 8 mna-assembler), computeIntegrationCoefficients (Item 7 integration.ts), analysisPhase (Item 15 coordinator) | M | `src/solver/analog/sparse-solver.ts`, `src/solver/analog/mna-assembler.ts`, `src/solver/analog/integration.ts`, `src/solver/analog/coordinator.ts` |

#### Wave 1.2 (parallel — types, NR engine, C callback)

| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| S1-D | All types.ts additions: Items 2,3,6,7,8,9,10,15 + remove rhs field | L | `src/solver/analog/__tests__/harness/types.ts` |
| S1-E | newton-raphson.ts: detailedConvergence (Item 8) + limitingCollector (Item 9) + extended postIterationHook signature | M | `src/solver/analog/newton-raphson.ts` |
| S1-F | niiter.c struct-based callback (Item 15 C summary): NiIterationData struct + ni_instrument_cb_v2 | L | `ref/ngspice/src/maths/ni/niiter.c` |

#### Wave 1.3 (parallel — capture, bridge, comparison integration)

| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| S1-G | All capture.ts changes: Items 2,6,7,9,10,11,15 — state history, preSolveRhs, matrix labels, limiting, convergence, node label fix, analysisPhase | L | `src/solver/analog/__tests__/harness/capture.ts` |
| S1-H | All ngspice-bridge.ts changes: Items 2,3,4,7,8,9,15 — struct callback decode, state1/state2, matrix CSC, device nodes, ag0/ag1, conv detail, limiting events | L | `src/solver/analog/__tests__/harness/ngspice-bridge.ts` |
| S1-I | Time-based step alignment (Item 1) + compare.ts alignment parameter | M | `src/solver/analog/__tests__/harness/comparison-session.ts`, `src/solver/analog/__tests__/harness/compare.ts` |

### Phase 2: Stream 3 — Query/Discovery/Filtering Layer

Spec: `docs/specs/harness-stream3-interface-methods.md`

17 new methods, 5 enhanced methods, 2 utility modules, type additions, 59 test cases.

#### Wave 2.1 (parallel — foundations: utilities + types + capture fix)

| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| S3-A | glob.ts + format.ts (new utility modules) | M | `src/solver/analog/__tests__/harness/glob.ts` (new), `src/solver/analog/__tests__/harness/format.ts` (new) |
| S3-B | normalizeDeviceType (device-mappings.ts) + captureTopology fix (capture.ts) + all new types (types.ts): PaginationOpts, ComponentInfo, NodeInfo, ComparedValue types, DivergenceReport, SlotTrace, StateHistoryReport, LabeledMatrix, LabeledRhs, MatrixComparison, IntegrationCoefficientsReport, LimitingComparisonReport, ConvergenceDetailReport, StepEndComponentEntry, SessionReport, enhanced type changes | L | `src/solver/analog/__tests__/harness/device-mappings.ts`, `src/solver/analog/__tests__/harness/capture.ts`, `src/solver/analog/__tests__/harness/types.ts` |

#### Wave 2.2 (parallel — ComparisonSession methods)

| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| S3-C | Methods 1-8: listComponents, listNodes, getComponentsByType, getComponentSlots, getDivergences, getStepEndRange, traceComponentSlot, getStateHistory | L | `src/solver/analog/__tests__/harness/comparison-session.ts` |
| S3-D | Methods 9-17: getMatrixLabeled, getRhsLabeled, compareMatrixAt, getIntegrationCoefficients, getLimitingComparison, getConvergenceDetail, toJSON, create, dispose + 5 enhanced methods (traceComponent, traceNode, getStepEnd, getIterations, getSummary) | L | `src/solver/analog/__tests__/harness/comparison-session.ts` |

Note: S3-C and S3-D both touch comparison-session.ts. They MUST run sequentially (S3-C first, then S3-D).

#### Wave 2.3 (sequential — tests)

| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| S3-E | query-methods.test.ts: 59 test cases covering glob, format, normalizeDeviceType, captureTopology fix, all 17 new methods, 5 enhanced methods, edge cases | L | `src/solver/analog/__tests__/harness/query-methods.test.ts` (new) |

### Phase 3: Stream 2 — MCP Tool Layer

Spec: `docs/specs/harness-stream2-mcp-tooling.md`

7 MCP tools, session management, query routing, JSON serialization, pagination.

#### Wave 3.1 (parallel — foundations + tools)

| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| S2-A | HarnessSessionState + FormattedNumber/serialization utilities | M | `scripts/mcp/harness-session-state.ts` (new), `scripts/mcp/harness-format.ts` (new) |
| S2-B | harness_start + harness_run + harness_dispose + harness_describe tools | L | `scripts/mcp/harness-tools.ts` (new) |

Note: S2-B depends on S2-A for HarnessSessionState and format utilities. Run sequentially.

#### Wave 3.2 (sequential — query tool + remaining tools)

| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| S2-C | harness_query (full routing table, 15 query modes) + harness_compare_matrix + harness_export | L | `scripts/mcp/harness-tools.ts` |

#### Wave 3.3 (sequential — integration + tests)

| ID | Title | Complexity | Files |
|----|-------|------------|-------|
| S2-D | circuit-mcp-server.ts integration (imports, harnessState, registerHarnessTools) + server instructions update + MCP tool tests | L | `scripts/circuit-mcp-server.ts`, test files |

## Test Command

```bash
npm run test:q
```

## Acceptance Criteria

### Phase 1
- All 16 Stream 1 items implemented per spec
- types.ts has all extended interfaces (state1Slots, state2Slots, preSolveRhs required, limitingEvents, convergenceFailedElements, integrationCoefficients, analysisPhase, matrixRowLabels, matrixColLabels, LimitingEvent, IntegrationCoefficients, RawNgspiceIterationEx extensions)
- rhs field removed from IterationSnapshot (no shim)
- niiter.c uses struct-based callback (NiIterationData + ni_instrument_cb_v2)
- Pre-solve RHS capture gated by boolean flag (zero cost when disabled)
- All engine changes performance-neutral when no capture active
- Existing tests pass

### Phase 2
- All 17 new methods on ComparisonSession
- All 5 enhanced methods with backward-compatible optional parameters
- glob.ts and format.ts utility modules created
- normalizeDeviceType exported from device-mappings.ts
- captureTopology populates type field on all elements
- StepEndReport.components uses StepEndComponentEntry
- 59 test cases in query-methods.test.ts pass
- toJSON output passes JSON.parse(JSON.stringify()) roundtrip

### Phase 3
- 7 MCP tools registered: harness_start, harness_run, harness_query, harness_describe, harness_compare_matrix, harness_export, harness_dispose
- HarnessSessionState manages session lifecycle
- harness_query implements full 15-row routing table
- All numeric output uses FormattedNumber (engineering notation)
- ComparedValueJSON serialization (NaN→null, Map→Record, Float64Array→number[])
- Pagination on all collection results with total/offset/limit
- "Did you mean" suggestions for unknown component labels
- Integration in circuit-mcp-server.ts
- Existing tests pass
