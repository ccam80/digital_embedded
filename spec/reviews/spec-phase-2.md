# Spec Review: Phase 2 — NR Loop Alignment

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 3 | 3 |
| major    | 1 | 4 | 5 |
| minor    | 1 | 2 | 3 |
| info     | 1 | 0 | 1 |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| Wave 2.1: pnjlim/fetlim fixes | yes | Tasks 2.1.1, 2.1.2 |
| Wave 2.1: hadNodeset gate on ipass | yes | Task 2.1.3 |
| Wave 2.2: cktLoad single-pass | yes | Task 2.2.1 |
| Wave 2.2: Delete MNAAssembler | yes | Task 2.2.2 |
| newtonRaphson signature change to `(ctx): void` | partial | Not explicitly addressed in any Phase 2 task |
| E_SINGULAR continue-to-CKTload | no | Master plan resolution not covered by any Phase 2 task |

## Mechanical Fixes
| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | major | §Task 2.2.2 Tests | "Existing MNA end-to-end tests must pass" is not a test spec | Replace with explicit migration: "Tests in `mna-assembler.test.ts` exercising end-to-end NR convergence must be migrated to `ckt-load.test.ts` with same assertions; no tests deleted without replacement" |
| M2 | minor | §Task 2.2.2 Files to modify | `mna-assembler.test.ts` listed as "modify" but description says "Delete or migrate" | Move to "Files to delete or migrate" with explicit outcome |

## Decision-Required Items

### D1 — Missing task: E_SINGULAR continue-to-CKTload (critical)
- **Location**: Phase 2, entire spec
- **Problem**: Master plan states "E_SINGULAR → continue to CKTload" but no Phase 2 task covers this. Current code breaks out of NR on singular failure.
- **Options**: (A) Add Task 2.2.3 explicitly fixing E_SINGULAR path; (B) Defer to Phase 4 with cross-reference

### D2 — Missing task: newtonRaphson signature migration to (ctx): void (critical)
- **Location**: Phase 2, entire spec
- **Problem**: Plan File Impact Summary states `newton-raphson.ts` is "Major rewrite — takes ctx, void return" but no task specifies signature change
- **Options**: (A) Add Task 2.2.0 explicit signature migration; (B) Clarify signature change is entirely Phase 1's responsibility

### D3 — pnjlim fix formula has internal inconsistency (critical)
- **Location**: §Task 2.1.1 Bug 2
- **Problem**: Spec says ngspice formula is `log(1 + delta/vt)` (no +2), but proposed fix retains `2 + log(arg)`. Test reference value inherits inconsistency.
- **Options**: (A) Remove +2, assert `vold + vt * log(arg)`; (B) Keep +2, rewrite derivation to explain; (C) Rewrite both bugs from ngspice devsup.c:50-58 with mapping table

### D4 — Task 2.1.3 mixes ctx and opts without defining boundary (major)
- **Location**: §Task 2.1.3
- **Problem**: Gate uses `ctx.isDcOp` but current code uses `opts.isDcOp`; transition point unspecified
- **Options**: (A) State NR already takes ctx by 2.1.3 (depends on Phase 1); (B) Use interim `opts.isDcOp && ctx.hadNodeset`

### D5 — "Plan Appendix B" reference does not exist (major)
- **Location**: §Task 2.2.1
- **Problem**: Master plan has no Appendix B
- **Options**: (A) Remove reference, expand task description inline with ngspice cktload.c line numbers; (B) Add Appendix B to master plan

### D6 — Three-Surface Testing Rule not satisfied (minor)
- **Location**: Phase 2, all tasks
- **Options**: (A) Add E2E regression test in `e2e/parity/`; (B) Explicitly exempt, citing existing E2E tests

### D7 — "Delete or migrate" non-deterministic instruction in Task 2.2.2 (minor)
- **Location**: §Task 2.2.2
- **Options**: (A) Specify migrate all end-to-end tests, delete class-internal tests; (B) Specify delete entirely, cover via 2.2.1's three tests

## Info
- I1: Task 2.1.3 modifies `ckt-context.ts` (Phase 1 output) creating implicit prerequisite

Full report written to: spec/reviews/spec-phase-2.md
