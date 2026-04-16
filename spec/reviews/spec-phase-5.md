# Spec Review: Phase 5 — Transient Step Alignment

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 2 | 2 |
| major    | 1 | 5 | 6 |
| minor    | 1 | 2 | 3 |
| info     | 2 | 0 | 2 |

## Plan Coverage
All 8 planned tasks appear. No missing/split/merged tasks.

## Mechanical Fixes
| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | major | §Task 5.2.1 | "timestep.ts:402" is in `accept()` not `getClampedDt()`; surrounding text misleads | Change to "timestep.ts `accept()` (line 402) — breakpoint hit detection in the breakpoint-pop loop"; remove any implication fix is in `getClampedDt()` |
| M2 | minor | §Task 5.1.1 | "Delete BDF-2 history push loop" is ambiguous — pushes to `this._history`, not `_signHistory` | Clarify: "Delete the reactive-element terminal-voltage history push loop (feeds this._history for checkMethodSwitch, also being deleted)" |

## Decision-Required Items

### D1 — Removal of `_updateMethodForStartup()` breaks `tryOrderPromotion()` guard and leaves post-breakpoint reset unprotected (critical)
- **Location**: §Task 5.1.1
- **Problem**: After initial method becomes trapezoidal, `tryOrderPromotion()` guard `currentMethod !== "bdf1"` fires immediately making it permanent no-op. Post-breakpoint reset at line 416 setting `bdf1` may be incorrectly removed.
- **Options**: (A) Remove `_updateMethodForStartup()`, update `tryOrderPromotion()` guard to check only `_acceptedSteps <= 1`, preserve post-breakpoint reset; (B) Remove only `_updateMethodForStartup()`, add spec note guard semantics shift but remain valid

### D2 — Task 5.1.3 deletes loops whose responsibilities not yet covered by Phase 6 elements (critical)
- **Location**: §Task 5.1.3
- **Problem**: Phase 5 runs before Phase 6.2 (element rewrites); deleting updateChargeFlux/stampCompanion loops breaks all transient circuits
- **Options**: (A) Move Task 5.1.3 into Phase 6 Wave 6.3 (atomic deletion+replacement); (B) Reorder Phase 6.2 before Phase 5.1.3

### D3 — Task 5.1.4 binds preIterationHook to CKTCircuitContext which has no specified interface (major)
- **Location**: §Task 5.1.4
- **Problem**: No signature given; ckt-context.ts is a Phase 1 deliverable
- **Options**: (A) Add explicit signature to Task 5.1.4; (B) Drop Task 5.1.4, keep closure until Phase 6

### D4 — Task 5.2.1 `delmin` undefined (major)
- **Location**: §Task 5.2.1
- **Problem**: `delmin` used in formula/test but not mapped to codebase value
- **Options**: (A) Define `delmin = params.minTimeStep`; (B) Derive from tStop/reltol per ngspice formula

### D5 — Task 5.3.1 adds xfact to wrong file; file doesn't exist in Phase 5 (major)
- **Location**: §Task 5.3.1 Files to modify
- **Problem**: Adds xfact to ckt-context.ts but LoadContext is defined in load-context.ts (Phase 6 deliverable)
- **Options**: (A) Move xfact addition to Phase 6 Wave 6.1; (B) Fix file to load-context.ts with Phase 6.1 prerequisite

### D6 — Task 5.1.3 acceptance criteria introduce element.accept() without defining it (major)
- **Location**: §Task 5.1.3
- **Problem**: Current interface has updateCompanion/updateState/acceptStep separately; accept() not defined
- **Options**: (A) Define element.accept() as new unified post-acceptance method (Phase 6 interface change); (B) Reword criterion to use existing method names

### D7 — Task 5.2.1 ULP test values unverifiable without almostEqualUlps implementation (minor)
- **Location**: §Task 5.2.1 Tests
- **Options**: (A) Specify IEEE-754 bit-integer distance implementation; (B) Replace ULP-count test values with pre-computed float literals

### D8 — Task 5.3.1 xfact fallback `|| ctx.deltaOld[0]` needs rationale (minor)
- **Location**: §Task 5.3.1
- **Options**: (A) Remove guard, rely on seeding invariant with comment; (B) Keep guard, document intent

## Info
- I1: Task 5.1.2 acceptance criteria "no `bdf1` as initial method anywhere" too broad; accept() branch at line 416 correctly resets
- I2: Wave 5.3 single-task wave adds no structural value

Full report written to: spec/reviews/spec-phase-5.md
