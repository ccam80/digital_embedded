# Spec Review: Phase 6 — Model Rewrites

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 1 | 1 |
| major    | 0 | 4 | 4 |
| minor    | 1 | 3 | 4 |
| info     | 1 | 0 | 1 |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| Define LoadContext | yes | Task 6.1.1 |
| Redefine AnalogElement with load() | yes | Task 6.1.2 |
| Rewrite all ~65 elements atomically | partial | t.ts, coupled-inductor, schottky unaddressed |
| Update test infrastructure | yes | Task 6.3.1 |
| Delete integrateCapacitor/Inductor | yes | Task 6.3.2 |

## Mechanical Fixes
| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | minor | §Task 6.2.4 Description | Says "12 elements" but lists 9 implementation files + 1 base | Change to "9 elements" or enumerate full 12 |

## Decision-Required Items

### D1 — `behavioral-flipflop/t.ts` missing from Task 6.2.6 (critical)
- **Location**: §Task 6.2.6 Files to modify
- **Problem**: subdirectory has 6 variants but task lists only 5; t.ts uses old-interface methods that Phase 6.1.2 will break
- **Options**: (A) Add `behavioral-flipflop/t.ts` to file list; (B) Create separate sub-task

### D2 — `coupled-inductor.ts` not addressed (major)
- **Location**: §Task 6.2.2
- **Problem**: Helper calls `solver.stamp()` directly; signature interaction with LoadContext undefined
- **Options**: (A) Add to Task 6.2.2 with update note; (B) Add to Task 6.3.2; (C) Acceptance criterion: transformers extract ctx.solver, pass unchanged, no helper change needed

### D3 — `schottky.ts` factory not listed (major)
- **Location**: §Task 6.2.3
- **Problem**: Delegates to createDiodeElement; factory signature change could break it
- **Options**: (A) Add to Task 6.2.3 Files to modify; (B) Explicit acceptance criterion confirming delegation remains compatible

### D4 — `checkConvergence` signature change not called out (major)
- **Location**: §Task 6.1.2 and §Task 6.2.3
- **Problem**: Changes from 4-param (voltages, prevVoltages, reltol, iabstol) to 1-param (ctx); never explicitly flagged as breaking
- **Options**: (A) Add explicit "Changed signatures" subsection noting caller impact; (B) Add reltol/iabstol to LoadContext interface in Task 6.1.1

### D5 — Task 6.2.5 has no specific test assertions (major)
- **Location**: §Task 6.2.5
- **Problem**: Only "Existing active-element tests must pass"; no file names, no functional criterion
- **Options**: (A) Name existing test files; (B) Add parity test per element; (C) Combine A+B

### D6 — Task 6.2.7 description inconsistency (minor)
- **Location**: §Task 6.2.7
- **Problem**: References "break-before-make" but no such file exists; DAC/ADC/Schmitt grouping mixed with Task 6.2.5's active/ directory
- **Options**: (A) Fix description, keep grouping; (B) Move DAC/ADC/Schmitt to Task 6.2.5

### D7 — Tasks 6.2.1, 6.2.2 "one test per element" underspecified (minor)
- **Location**: §Tasks 6.2.1, 6.2.2
- **Options**: (A) Name test files and specify snapshot match; (B) Add to existing per-element test files; (C) Drop per-element requirement

### D8 — Task 6.2.6 "~18 elements" approximate and unenumerated (minor)
- **Location**: §Task 6.2.6
- **Options**: (A) Enumerate all class/factory names; (B) Replace count with programmatic acceptance criterion

## Info
- I1: Task 6.2.2 criterion "No calls to integrateCapacitor/Inductor from element code" redundant with Task 6.3.2 deletion

Full report written to: spec/reviews/spec-phase-6.md
