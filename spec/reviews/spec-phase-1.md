# Spec Review: Phase 1 — Zero-Alloc Infrastructure

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 2 | 2 |
| major    | 1 | 4 | 5 |
| minor    | 1 | 1 | 2 |
| info     | 1 | 0 | 1 |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| CKTCircuitContext god-object (single allocation point for all buffers) | yes | Task 1.1.1 |
| MNAAssembler hoisted to ctx in Phase 1 (temporary bridge) | partial | Task 1.1.2 mentions the hoist but the `assembler` field is absent from the Task 1.1.1 field list; implementer of 1.1.1 will not create it |
| `newtonRaphson(ctx): void` signature, writes `ctx.nrResult` | yes | Task 1.1.2 |
| `solveDcOperatingPoint(ctx): void` signature, writes `ctx.dcopResult` | yes | Task 1.1.3 |
| Zero allocations in NR, integration, LTE, DC-OP hot paths | partial | NR/DC-OP/integration covered; LTE hot path not addressed by any task |
| Pre-computed element lists eliminate `elements.filter(...)` calls | yes | Tasks 1.1.1 + 1.2.2 |
| Per-step closure elimination | yes | Task 1.2.2 |
| `solveGearVandermonde` flat scratch buffer | yes | Task 1.2.1 |
| `computeIntegrationCoefficients` deleted | yes | Task 1.2.1 |

## Findings

### Mechanical Fixes
| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | minor | Phase 1 §Task 1.2.2 "Files to modify" | `elements.filter(isPoolBacked)` anchored by bare line number "analog-engine.ts:347"; fragile | Replace with code-fragment anchor: "the `elements.filter(isPoolBacked)` call inside `refreshElementRefs`" |

### Decision-Required Items

#### D1 — Missing LTE zero-alloc coverage (critical)
- **Location**: Phase 1 overview; master plan governing principle #2
- **Problem**: Master plan mandates zero allocations in hot paths including LTE. No Phase 1 task audits LTE path (`ckt-terr.ts` and element LTE methods).
- **Options**:
  - **A — Add LTE audit task to Phase 1**: New Task 1.2.3 auditing `ckt-terr.ts` and per-step LTE call sites for allocations.
  - **B — Explicitly defer to Phase 3**: Add note "LTE path zero-alloc is deferred to Phase 3" + corresponding Phase 3 task.
  - **C — Confirm LTE already allocation-free**: Inspect code; add acceptance criterion confirming no allocations.

#### D2 — `MNAAssembler` field missing from CKTCircuitContext field list (critical)
- **Location**: Phase 1 §Task 1.1.1 field list; §Task 1.1.2
- **Problem**: Task 1.1.2 references `ctx.assembler` but Task 1.1.1 doesn't list it. Implementer of 1.1.1 produces incomplete class.
- **Options**:
  - **A — Add `assembler: MNAAssembler` to Task 1.1.1 field list**
  - **B — Specify the hoist in Task 1.1.2's "Files to modify" for `ckt-context.ts`**

#### D3 — "Appendix A" is a dangling citation (major)
- **Location**: Phase 1 §Task 1.1.1 "Fields (from plan Appendix A):"
- **Problem**: Master plan has no Appendix A.
- **Options**:
  - **A — Delete the parenthetical**: Inline list in 1.1.1 is canonical.
  - **B — Add Appendix A to master plan**: Shared reference for all phases.

#### D4 — `deltaOld: number[7]` is an invalid TypeScript type (major)
- **Location**: Phase 1 §Task 1.1.1 "Fields"
- **Problem**: `number[7]` isn't valid TS syntax. Type could be `Float64Array`, `number[]`, or 7-tuple.
- **Options**:
  - **A — `Float64Array` (length 7)**: Consistent with `ag`/`agp`; requires updating `computeNIcomCof`/`solveGearVandermonde` param types.
  - **B — `number[]` (pre-allocated length 7)**: No API change needed.
  - **C — 7-element tuple**: Verbose; assignability issues.

#### D5 — `FinalizationRegistry` zero-alloc tests not implementable (major)
- **Location**: §Task 1.1.1 `zero_allocations_on_reuse`; §Task 1.1.2 `zero_allocations_in_nr_loop`
- **Problem**: `FinalizationRegistry` fires on GC asynchronously; cannot detect allocation. No "allocation counter" API exists.
- **Options**:
  - **A — Monkey-patch `Float64Array` constructor**: Counting wrapper in test setup.
  - **B — Structural source-level enforcement**: CI lint/script scans for `new Float64Array` in NR loop body.
  - **C — `v8.getHeapStatistics()` with GC forcing**: Heap delta + `--expose-gc`.

#### D6 — Three-Surface Testing Rule compliance unaddressed (minor)
- **Location**: Phase 1 — all tasks; `CLAUDE.md` Three-Surface Rule
- **Problem**: All Phase 1 tests are surface 1 only. Unclear whether engine-internal refactors are exempt.
- **Options**:
  - **A — Explicitly exempt engine internals** with reference to existing integration tests.
  - **B — Add MCP regression citations to each task**.

### Info
#### I1 — `NrBase` interface deletion noted (info)
- Confirmed at `dc-operating-point.ts:627`; deletion correct but easy to miss.

Full report written to: spec/reviews/spec-phase-1.md
