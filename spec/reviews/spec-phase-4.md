# Spec Review: Phase 4 — DC Operating Point Alignment

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 3 | 3 |
| major    | 0 | 3 | 3 |
| minor    | 0 | 2 | 2 |
| info     | 0 | 1 | 1 |

## Plan Coverage
All 5 DC-OP sub-algorithms covered. Plan verification gap: per-NR-iteration parity against ngspice is not in any Phase 4 acceptance criteria (only unit tests).

## Mechanical Fixes
None found.

## Decision-Required Items

### D1 — Task 4.1.1 references ctx object that doesn't exist in Phase 4 (critical)
- **Location**: §Task 4.1.1
- **Problem**: Current code uses options-object spread; no `ctx.noncon` exists. Phase 1 delivery (CKTCircuitContext) must precede Task 4.1.1.
- **Options**: (A) Update spec to use Phase 1 CKTCircuitContext API with prerequisite note; (B) Add initialNoncon field to NR options (targets current code); (C) Drop as already-handled by `assembler.noncon = 1` at line 568

### D2 — Task 4.1.2 contradicts existing passing test (critical)
- **Location**: §Task 4.1.2
- **Problem**: Existing test `dcopFinalize_sets_initMode_to_transient_after_convergence` asserts opposite of proposed new test
- **Options**: (A) Delete existing test + line (ngspice authority); (B) Preserve transient reset, remove Task 4.1.2

### D3 — Task 4.2.1 self-contradicting description defers verification to implementer (critical)
- **Location**: §Task 4.2.1
- **Problem**: First sentence says change code; second paragraph says "may already match" and asks implementer to verify against ngspice source
- **Options**: (A) Confirm current code correct, convert to verification-only task; (B) Resolve definitively, rewrite with single unambiguous statement

### D4 — Task 4.2.3 iteration limit contradicts existing code comment at same line (major)
- **Location**: §Task 4.2.3
- **Problem**: Spec says cktop.c:253 uses `iterlim` (100); code comment at same line says "ngspice uses dcTrcvMaxIter here" (50)
- **Options**: (A) Spec correct, update code to params.maxIterations; (B) Comment correct, retract Task 4.2.3

### D5 — Task 4.4.1 test doesn't specify circuit forcing spice3Src path (major)
- **Location**: §Task 4.4.1
- **Problem**: spice3Src only reached if direct NR and spice3Gmin both fail; no test circuit specified. spice3Src not exported.
- **Options**: (A) Specify concrete circuit with numSrcSteps=4 and dcTrcvMaxIter=1 forcing fallback; (B) Export spice3Src for direct testing

### D6 — Task 4.5.1 proposed fix is dead assignment in current architecture (major)
- **Location**: §Task 4.5.1
- **Problem**: diagGmin not read after line 1003; source-stepping loop passes no diagonalGmin (defaults 0). Assignment would be no-op.
- **Options**: (A) Confirm behavior already matches (params.gshunt=0 default), drop task; (B) Rewrite fix to pass `diagonalGmin: params.gshunt ?? 0` into stepping loop NR calls

### D7 — No ngspice harness parity coverage in Phase 4 (minor)
- **Location**: All tasks
- **Options**: (A) Add parity smoke tests for circuits 1-2 (partial parity, Phase 6 gated); (B) Explicitly defer all parity to Phase 7

### D8 — Task 4.3.1 formula double-evaluates nullable coalesce (minor)
- **Location**: §Task 4.3.1
- **Options**: (A) Simplify: `const gs = params.gshunt ?? 0; let diagGmin = gs === 0 ? params.gmin : gs;`; (B) Accept literal formula

## Info
- I1: None

Full report written to: spec/reviews/spec-phase-4.md
