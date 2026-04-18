# Review Report: Phase 3 — Numerical Fixes

## Summary

- **Tasks reviewed**: 6 (3.1.1, 3.1.2, 3.1.3, 3.2.1, 3.2.2, 3.2.3)
- **Violations found**: 14 (0 critical, 5 major, 9 minor)
- **Gaps found**: 3
- **Verdict**: has-violations

## Violations

### V-01: Banned word "fallback" in comment
- **File**: `src/solver/analog/ckt-terr.ts`:133-134
- **Rule**: rules.md §Code Hygiene — banned word "fallback"
- **Evidence**: `//   h1 = deltaOld[1] (step n-1), fallback to dt`  `//   h2 = deltaOld[2] (step n-2), fallback to h1`
- **Severity**: minor

### V-02: Historical-provenance comment "After formula fix (Phase 3)"
- **File**: `src/solver/analog/__tests__/ckt-terr.test.ts`:53
- **Evidence**: `// After formula fix (Phase 3): TRAP order 2 and BDF2 order 2 use different formula families.`
- **Severity**: minor

### V-03: Historical-provenance comment "After Phase 3 formula fixes"
- **File**: `src/solver/analog/__tests__/ckt-terr.test.ts`:123
- **Severity**: minor

### V-04: Historical-provenance comment "batch-3 at commit ecdc34a"
- **File**: `src/solver/analog/__tests__/ckt-terr.test.ts`:310-312
- **Evidence**: `// Regression guard against the incorrect 5/72 value that shipped in // batch-3 at commit ecdc34a.`
- **Severity**: minor

### V-05: Historical-provenance + deferred-finding narrative embedded in test
- **File**: `src/solver/analog/__tests__/integration.test.ts`:316-320
- **Rule**: historical-provenance ban + deferred-work ban
- **Evidence**:
  ```
  // Known divergence at commit ecdc34a: ag[0] produces 2083333.333333333
  // (1 ULP low vs closed-form 2083333.3333333333 = 25/(12*h)). This is a
  // real numerical divergence from the mathematical ideal and (likely)
  // from ngspice — not a test-infra issue. Keep the assertion strict so
  // it stays flagged as a finding for batch-4 remediation.
  ```
- **Severity**: major

### V-06: `toBeCloseTo` on GEAR order 2 coefficients
- **File**: `src/solver/analog/__tests__/integration.test.ts`:113-115, 221-223
- **Rule**: Phase 3 testing policy — "No `toBeCloseTo` in numerical tests — they must be bit-exact (`toBe`)"
- **Evidence**: `expect(ag[0]).toBeCloseTo(3 / (2 * h), 8);` etc.
- **Severity**: major

### V-07: `toBeCloseTo` on GEAR order 3 coefficients
- **File**: `src/solver/analog/__tests__/integration.test.ts`:123-126, 233-236
- **Severity**: major

### V-08: `toBeCloseTo` on GEAR order 4 coefficients
- **File**: `src/solver/analog/__tests__/integration.test.ts`:131-133, 245-249
- **Severity**: major

### V-09: `toBeCloseTo` on GEAR order 5 and 6 coefficients
- **File**: `src/solver/analog/__tests__/integration.test.ts`:138-139, 144-145, 257-262, 269-276
- **Severity**: major

### V-10: `toBeCloseTo` on HistoryStore values
- **File**: `src/solver/analog/__tests__/integration.test.ts`:46-47, 71-74, 91-92
- **Severity**: minor

### V-11: `toBeCloseTo` on BDF-1 / trapezoidal order 1 coefficients
- **File**: `src/solver/analog/__tests__/integration.test.ts`:174-175, 181-182
- **Severity**: minor

### V-12: `toBeCloseTo` on trapezoidal order 2 / BDF-2 coefficients
- **File**: `src/solver/analog/__tests__/integration.test.ts`:189-190, 199-201, 210-212
- **Severity**: minor

### V-13: Scope creep — unspecified test `gear_lte_factor_order_5` added
- **File**: `src/solver/analog/__tests__/ckt-terr.test.ts`:277-313
- **Evidence**: Task 3.1.2 specifies exactly two tests (order_3 and order_6); order_5 added unspecified
- **Severity**: minor

### V-14: Progress-log inconsistency claiming fix to deleted functions
- **File**: `spec/progress.md` (Task 3.2.2 entry)
- **Evidence**: Claims "Fixed integrateCapacitor and integrateInductor trap order 2" — those functions were deleted in Task 6.3.2
- **Severity**: minor

## Gaps

### G-01: Task 3.2.1 required test `nicomcof_trap_order2_matches_ngspice_rounding` absent
- **Spec**: differential test with `dt=1.23456789e-7`, `xmu=1/3` asserting new formula differs from old rounding
- **Actual**: Only trap-order-2 test uses `xmu=0.5` with `toBeCloseTo` — cannot distinguish rounding paths

### G-02: Task 3.2.2 required test `trap_order2_ccap_with_nonstandard_xmu` absent
- **Spec**: Test with `xmu=0.3`, q0=1e-12, q1=0.9e-12, ccapPrev=1e-6, dt=1e-9
- **Actual**: No such test exists

### G-03: Task 3.2.2 target functions deleted — acceptance cannot be verified
- **Spec**: Fix `integrateCapacitor` line 53 and `integrateInductor` line 114
- **Actual**: Both deleted in Task 6.3.2; no non-0.5 xmu exercised through remaining code paths

## Weak Tests

### T-01: `cktTerr::order 1 bdf1 returns finite positive timestep`
- **Test**: `ckt-terr.test.ts::cktTerr::order 1 bdf1 returns finite positive timestep for non-trivial charges`
- **Issue**: Only `toBeGreaterThan(0)` + `isFinite` — no reference value

### T-02: `cktTerr::order 2 bdf2 returns sqrt-scaled timestep`
- **Test**: `ckt-terr.test.ts::cktTerr::order 2 bdf2: returns sqrt-scaled timestep`
- **Issue**: Name promises sqrt verification; only positivity/finiteness asserted

### T-03: `cktTerr::constant charge history produces finite timestep`
- **Test**: `ckt-terr.test.ts::cktTerr::constant charge history produces finite timestep`
- **Issue**: No reference value

### T-04: `cktTerr::bdf2 order 2 cubic data`
- **Test**: `ckt-terr.test.ts::cktTerr::bdf2 order 2 returns positive finite timestep for cubic charge data`
- **Issue**: Positivity/finiteness only for both methods

### T-05 through T-09: Same issue on cktTerrVoltage tests (5 more)

### T-10: `computeNIcomCof trapezoidal order 2 (xmu=0.5)` uses `toBeCloseTo`
- **Test**: `integration.test.ts::computeNIcomCof::trapezoidal order 2: ag[0]=2/dt, ag[1]=1 (xmu=0.5)`
- **Issue**: Only numerically-oriented test of the xmu=0.5 trap order 2 branch where Task 3.2.1 changed rounding; must be bit-exact

## Legacy References

### L-01: `ckt-terr.test.ts`:310-311 — "batch-3 at commit ecdc34a"
### L-02: `integration.test.ts`:316-320 — "commit ecdc34a"/"batch-4 remediation"
### L-03: `ckt-terr.test.ts`:53 — "After formula fix (Phase 3)"
### L-04: `ckt-terr.test.ts`:123 — "After Phase 3 formula fixes"

## Additional Notes (Not Violations)

- Task 3.1.1 chargetol formula and test — correct.
- Task 3.1.2 GEAR LTE factor — correct (plus V-13 scope creep).
- Task 3.1.3 V3/V4/V5/V6 formulas — correct.
- Task 3.2.1 rounding — formula applied but spec-required differential test absent (G-01).
- Task 3.2.3 Gear Vandermonde regression — correct (aside from V-05 comment).
