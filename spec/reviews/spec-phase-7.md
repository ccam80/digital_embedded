# Spec Review: Phase 7 — Verification

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 3 | 3 |
| major    | 0 | 6 | 6 |
| minor    | 1 | 3 | 4 |
| info     | 0 | 2 | 2 |

## Plan Coverage
All 8 verification circuits covered. Gaps: state0[] comparison not required in any task's acceptance criteria; noncon/diagGmin/srcFact only partially covered; iteration count only in 2 of 8 tasks.

## Mechanical Fixes
| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | minor | §Task 7.1.1 Tests | "The helpers themselves are tested by the circuit-specific tests below" is vacuous and self-referential | Replace with: "parity-helpers.ts contains no independently-runnable tests; helper correctness is transitively validated through Tasks 7.2.1–7.4.1" |

## Decision-Required Items

### D1 — Zero-tolerance vs 15-significant-digits contradiction (critical)
- **Location**: §Task 7.1.1 vs per-task acceptance criteria
- **Problem**: 7.1.1 says "zero tolerance (exact IEEE-754 match)"; per-task criteria say "15 significant digits"
- **Options**: (A) Exact IEEE-754 throughout; (B) Define concrete tolerance pair (relTol=1e-14, absTol=1e-12); (C) Two-tier: rhsOld uses 1e-14 relTol, state0[] uses per-slot tolerances

### D2 — state0[] match not required in any circuit test (critical)
- **Location**: §Tasks 7.2.1–7.3.4
- **Problem**: Master plan requires device state matching; no task asserts it explicitly
- **Options**: (A) Explicit per-task state0[] criteria with device slot names; (B) Delegate to parity-helpers contract, state assertIterationMatch MUST compare state0[]

### D3 — noncon/diagGmin/srcFact not required for all circuits (critical)
- **Location**: §Tasks 7.2.1, 7.2.3, 7.2.4, 7.3.1-7.3.4
- **Problem**: Plan requires match "at every iteration/step" but only partial coverage in spec
- **Options**: (A) Add convergence scalar assertions to every task body; (B) Mandate assertConvergenceFlowMatch at helper level

### D4 — parity-helpers.ts interface undefined (major)
- **Location**: §Task 7.1.1 Files to create
- **Problem**: No parameter types, return types, or failure semantics specified
- **Options**: (A) Full TypeScript signatures in spec; (B) Prose descriptions of semantics

### D5 — No circuit fixtures, parameters, or engine invocation pattern specified (major)
- **Location**: §Tasks 7.2.1–7.3.4
- **Problem**: No .cir/.dts file paths, component values, or instructions for loading/invoking engines
- **Options**: (A) ComparisonSession + .dts fixtures (existing pattern); (B) Programmatic circuit construction + raw NgspiceBridge with inline netlists

### D6 — DLL availability guard pattern unspecified (major)
- **Location**: §Tasks 7.2.1–7.3.4
- **Options**: (A) Per-file describe.skip guard with centralised DLL_PATH; (B) it.skipIf + NGSPICE_DLL_PATH env var

### D7 — Transient test step counts arbitrary without circuit parameters (major)
- **Location**: §Tasks 7.3.1, 7.3.2
- **Problem**: "100 accepted steps" / "200 accepted steps" not reproducible without R, C, L, source, stopTime, maxStep
- **Options**: (A) Replace counts with stopTime + circuit parameters; (B) Keep counts as cap, add minimum required parameters

### D8 — "LTE-proposed dt" is not an observable harness field (major)
- **Location**: §Task 7.3.1
- **Options**: (A) Reinterpret as accepted dt sequence; (B) Add lteDt capture to harness (expands scope)

### D9 — Task 7.4.1 has no Files to create; mode assertions not in circuit tasks (major)
- **Location**: §Task 7.4.1
- **Options**: (A) Add explicit mode assertion to each circuit task's test body; (B) Remove Task 7.4.1, fold into Task 7.1.1

### D10 — Oscillation frequency/amplitude assertion has no reference values (minor)
- **Location**: §Task 7.3.2
- **Options**: (A) Specify circuit params with derived reference; (B) Replace with per-step match criterion

### D11 — "ULP precision" for breakpoint times undefined (minor)
- **Location**: §Task 7.3.3
- **Options**: (A) Replace with "exact IEEE-754 match"; (B) Use existing harness timeDeltaTol=1e-12

### D12 — Diode bridge "2 full AC cycles" with no source frequency (minor)
- **Location**: §Task 7.3.3
- **Options**: (A) Specify full parameters (60Hz, 1V peak, R=1kΩ, C=100µF, stopTime=33.3ms); (B) Replace with concrete stopTime

## Info
None.

Full report written to: spec/reviews/spec-phase-7.md
