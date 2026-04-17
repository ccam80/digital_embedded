# Review Report: Phase 3 — Numerical Fixes

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 6 |
| Violations — critical | 1 |
| Violations — major | 2 |
| Violations — minor | 2 |
| Gaps | 2 |
| Weak tests | 7 |
| Legacy references | 0 |

**Verdict: has-violations**

---

## Violations

### V-01 — CRITICAL: GEAR_LTE_FACTORS[4] value contradicts repo's own ngspice cross-reference

- **File**: `src/solver/analog/ckt-terr.ts:45`
- **Rule violated**: SPICE-Correct Implementations Only (CLAUDE.md); spec Task 3.1.2 acceptance criterion "GEAR LTE factors for orders 1-6 match ngspice geardefs.h exactly"
- **Evidence**:

The current code at line 45 is:
```typescript
export const GEAR_LTE_FACTORS = [0.5, 2 / 9, 3 / 22, 12 / 125, 5 / 72, 20 / 343];
```

`GEAR_LTE_FACTORS[4]` is `5 / 72 = 0.069444...`

The repo's own authoritative cross-reference document at `spec/state-machines/ngspice-cktterr-vs-ckt-terr.md` line 85 reads:

> `.07299270073,` (line 29) - gearCoeff[4] truncated decimal for **10/137** | `10 / 137,` (line 47, element 4) ...

The cross-reference explicitly identifies gearCoeff[4] as `10/137 = 0.07299270073...`, not `5/72`. The progress log entry for Task 3.1.2 states: "GEAR_LTE_FACTORS[4] corrected to `5/72` per geardefs.h (was 10/137)." This reversal is unsubstantiated — the repo's own spec document (which was written from direct inspection of ngspice geardefs.h) records the canonical value as `10/137`. The agent changed the value FROM `10/137` TO `5/72` and called it a correction, which is backwards.

Numerical impact: `5/72 = 0.06944...` vs `10/137 = 0.07299...`. A factor of ~5% error. For GEAR order 5, the LTE coefficient is wrong, causing the timestep controller to propose a ~5% oversized step, potentially accepting steps that should be rejected.

The spec acceptance criterion (Task 3.1.2) requires exact agreement with ngspice geardefs.h. The existing tests for this task cover only orders 3 and 6 (`gear_lte_factor_order_3` and `gear_lte_factor_order_6`) — neither test asserts the order-5 factor value. This is what allowed the wrong value to survive.

**Severity: critical** — wrong numerical constant in the LTE factor table, contradicts the repo's own ngspice mapping document.

---

### V-02 — MAJOR: `deltaOld` indexing inconsistency — h1 reads index [1] but comment says [0]

- **File**: `src/solver/analog/ckt-terr.ts:118-127`
- **Rule violated**: SPICE-Correct Implementations Only (CLAUDE.md); spec Task 3.1.3 acceptance criterion "Both `cktTerr` and `cktTerrVoltage` produce IEEE-754 identical results to ngspice CKTtrunc for all method/order combinations"
- **Evidence**:

```typescript
// line 118-127 in cktTerr (same pattern at lines 265-267 in cktTerrVoltage):
const h0 = dt;
const h1 = deltaOld.length > 1 ? deltaOld[1] : dt;  // reads index [1]
const h2 = deltaOld.length > 2 ? deltaOld[2] : h1;  // reads index [2]
```

The inline comment at line 120 says:
```
//   h1 = deltaOld[0] (step n-1), fallback to dt
```

But the code reads `deltaOld[1]`, not `deltaOld[0]`. The comment states the intent is `deltaOld[0]`; the code implements `deltaOld[1]`.

The cross-reference doc (line 133 in the state-machines doc) states:
> `const h1 = deltaOld.length > 1 ? deltaOld[1] : dt;` ... DIFF (TS fallback behavior: if deltaOld has fewer than 2 entries, reuse dt. ngspice always has deltaOld[0..6] allocated...)

Ngspice's `deltmp[]` array is initialised from `CKTdeltaOld[i]` starting at `i=0`. In ngspice `dctran.c`, `CKTdeltaOld[0]` is set to `CKTdelta` (the current step) before the loop runs. So `CKTdeltaOld[0]` = h0 (current dt), and `CKTdeltaOld[1]` = h_{n-1} (the previous accepted step). The TS code passes `dt` as the explicit first argument, so `deltaOld[0]` should be h_{n-1} and `deltaOld[1]` should be h_{n-2}. The comment at line 120 says h1 = deltaOld[0] and the code uses deltaOld[1]. One of them is wrong; they are inconsistent with each other.

The TRAP and GEAR formulas then use `d0 = deltaOld[0]` as the multiplier for the step scaling term (line 177, line 182, line 312, line 317). If the divided-difference denominator uses a shifted index compared to the multiplier, the result is incorrect for unequal-step histories (equal steps cancel the bug).

The tests all use equal-step histories (`deltaOld = [1e-6, 1e-6, ...]`) so this inconsistency cannot be detected by any existing test.

**Severity: major** — dormant bug in deltaOld index convention, inconsistency between comment and code, undetectable by existing equal-step tests.

---

### V-03 — MAJOR: Task 3.2.3 test uses `toBeCloseTo` / relative tolerance assertions instead of bit-exact

- **File**: `src/solver/analog/__tests__/integration.test.ts:762-769` (gear_vandermonde_flat_scratch_regression)
- **Rule violated**: rules.md "Test the specific: exact values, exact types, exact error messages where applicable"; spec Task 3.2.3 acceptance criterion requires numerical correctness verification
- **Evidence**:

```typescript
const tol = 1e-6;
expect(Math.abs(ag[0] - 25 / (12 * h))).toBeLessThan(tol / h);
expect(Math.abs(ag[1] - (-4 / h))).toBeLessThan(tol / h);
expect(Math.abs(ag[2] - (3 / h))).toBeLessThan(tol / h);
expect(Math.abs(ag[3] - (-4 / (3 * h)))).toBeLessThan(tol / h);
expect(Math.abs(ag[4] - (1 / (4 * h)))).toBeLessThan(tol / h);
```

The spec says: "assert `ag[0..4]` match pre-computed reference values for GEAR order 4 (spec author inlines exact Float64 references from the known-good nested-array implementation)." The implementation uses `LessThan(tol/h)` tolerance checks, not `toBe()` bit-exact assertions. For `h=1e-6`, `tol/h = 1e-6/1e-6 = 1`, meaning any value within ±1 of the reference passes. This would not catch a regression that produced, for example, `ag[0] = 2079166 + 0.9` (wrong by 0.9) — it would still pass. The spec explicitly requires inlined exact Float64 references asserted with bit-exact comparison. The tolerance is so loose as to be nearly trivially true for this scale.

**Severity: major** — the regression test cannot detect regressions within ±1 of the reference, which is a large fraction of the expected value at this scale.

---

### V-04 — MINOR: Missing ngspice source citation comment for Bug C2 formula fix

- **File**: `src/solver/analog/ckt-terr.ts:190`
- **Rule violated**: SPICE-Correct Implementations Only (CLAUDE.md) — "match the corresponding ngspice source function exactly... Provide a mapping table from ngspice variables to ours"
- **Evidence**:

```typescript
// ngspice geardefs.h: GEAR_LTE_FACTORS indexed by (order-1)
const factor = GEAR_LTE_FACTORS[Math.min(order - 1, GEAR_LTE_FACTORS.length - 1)];
```

The comment cites `geardefs.h` generically but does not provide the specific line number in ngspice geardefs.h, nor the exact C source fragment. The spec for Task 3.1.2 says "ngspice reference: geardefs.h LTE factor table" — a line number citation was expected per the "SPICE-Correct Implementations Only" rule which requires exact mapping tables. For V3/V4/V5/V6 in ckt-terr.ts the comments are similarly informal (e.g. line 176: `// ngspice cktterr.c TRAP order 1: del = deltaOld[0] * sqrt(trtol * tol * 2 / diff)` — no file:line citation). However, the formula is quoted so this is a minor issue.

**Severity: minor**

---

### V-05 — MINOR: Missing ngspice source citation for Bug 3.2.1 formula fix in computeNIcomCof

- **File**: `src/solver/analog/integration.ts:444`
- **Rule violated**: SPICE-Correct Implementations Only (CLAUDE.md) — citation to specific ngspice source file and line
- **Evidence**:

```typescript
// nicomcof.c trap order 2: two sequential divisions match ngspice operand order
ag[0] = 1.0 / dt / (1.0 - xmu);
```

The comment references `nicomcof.c` but does not give a line number. The spec for Task 3.2.1 says "ngspice reference: nicomcof.c trap order 2" — an informal reference, but the CLAUDE.md rule requires mapping the ngspice variable names. The comment does not provide the variable-name mapping table as required by the SPICE rule.

**Severity: minor**

---

## Gaps

### G-01: Task 3.1.1 — spec requires `__testHooks.lastChargetol` to capture pre-division value; implementation uses a different name and scope

- **Spec requirement** (Task 3.1.1 Tests): "Assert the intermediate `chargetol` value (exposed via a new test-only export `__testHooks.lastChargetol`) equals `1e-17` exactly (IEEE-754 bit-identical)."
- **What was found**: The spec says `lastChargetol` should capture the pre-division intermediate. Looking at the code:

  ```typescript
  // ckt-terr.ts:159-161
  const chargetolRaw = params.reltol * Math.max(Math.max(Math.abs(q0), Math.abs(q1)), params.chgtol);
  __testHooks.lastChargetol = chargetolRaw;  // stores pre-division value = 1e-17
  const chargetol = chargetolRaw / dt;
  ```

  And the test:
  ```typescript
  // ckt-terr.test.ts:248-250
  const expected = 1e-3 * Math.max(Math.max(1e-16, 1e-16), 1e-14);
  expect(expected).toBe(1e-17); // confirm reference is exactly 1e-17
  expect(__testHooks.lastChargetol).toBe(expected); // bit-exact
  ```

  The implementation stores `chargetolRaw` (before dividing by dt), which equals `1e-17` for the test inputs. The test correctly asserts this. This gap finding is not a defect in isolation — the implementation matches the spec intent. **Closing this gap as a false lead; no gap here.**

### G-01 (reassigned): Task 3.1.2 — No test for GEAR_LTE_FACTORS[4] (order 5); only orders 3 and 6 are tested

- **Spec requirement** (Task 3.1.2 Acceptance): "GEAR LTE factors for orders 1-6 match ngspice geardefs.h exactly."
- **What was found**: Tests `gear_lte_factor_order_3` (asserts `GEAR_LTE_FACTORS[2] = 3/22`) and `gear_lte_factor_order_6` (asserts `GEAR_LTE_FACTORS[5] = 20/343`) exist. No test asserts the value of `GEAR_LTE_FACTORS[4]` (order 5). This is the precise gap that allowed the wrong `5/72` value for order 5 to survive undetected — as documented in Violation V-01.
- **File**: `src/solver/analog/__tests__/ckt-terr.test.ts` — missing `gear_lte_factor_order_5` test
- **Severity**: This gap directly enabled V-01. The spec required testing all 6 values; only 2 are tested.

### G-02: Task 3.2.3 — spec requires inlined exact Float64 reference literals; test uses tolerance-based assertions

- **Spec requirement** (Task 3.2.3 Tests): "Assert `ag[0..4]` match pre-computed reference values for GEAR order 4 (spec author inlines exact Float64 references from the known-good nested-array implementation)."
- **What was found**: The test at lines 762–769 uses `Math.abs(ag[k] - ref) < tol/h` with `tol = 1e-6`. No inlined exact Float64 literals are present. The expected values are computed inline as ratios (`25/(12*h)`) which is correct, but the assertion is not bit-exact (`toBe`). This is both a Gap (wrong assertion type) and V-03.
- **File**: `src/solver/analog/__tests__/integration.test.ts:762-769`

---

## Weak Tests

### WT-01: `gear_lte_factor_order_6` — positive/finite check insufficient for regression coverage

- **Test**: `src/solver/analog/__tests__/ckt-terr.test.ts::gear_lte_factor_selection::gear_lte_factor_order_6`
- **Lines**: 300–314
- **Problem**: After asserting `GEAR_LTE_FACTORS[5] === 20/343`, the test only checks:
  ```typescript
  expect(resultOrder6).toBeGreaterThan(0);
  expect(isFinite(resultOrder6)).toBe(true);
  expect(resultOrder6).toBeGreaterThan(resultOrder2);
  ```
  The `greaterThan(resultOrder2)` check is a direction check but not a bit-exact or even approximate reference check. It would pass with any value that happens to be larger than the order-2 result, which does not verify the specific coefficient value.

### WT-02: `gear_lte_factor_order_3` — uses `toBeCloseTo(expectedOrder3, 10)` instead of `toBe`

- **Test**: `src/solver/analog/__tests__/ckt-terr.test.ts::gear_lte_factor_selection::gear_lte_factor_order_3`
- **Lines**: 262–298
- **Problem**:
  ```typescript
  expect(resultOrder3).toBeCloseTo(expectedOrder3, 10);
  ```
  `toBeCloseTo(x, 10)` checks to 10 decimal places (~1e-10 relative tolerance). The spec requires bit-exact IEEE-754 assertions (`toBe`). For a pure arithmetic formula, the reference is computed identically in both test and implementation, so `toBe` would pass. The use of `toBeCloseTo` is a weaker assertion than required.

### WT-03: `cktTerrVoltage_gear_order2_matches_ngspice` — bit-exact test, passes (not weak). Confirmed clean.

(No weak test — this uses `expect(result).toBe(reference)` correctly. Removing from weak tests.)

### WT-03: `order 1: quadratic voltage gives correct result by manual calculation` — uses `toBeCloseTo(expectedResult, 8)`

- **Test**: `src/solver/analog/__tests__/ckt-terr.test.ts::cktTerrVoltage::order 1: quadratic voltage gives correct result by manual calculation`
- **Lines**: 93–113
- **Problem**:
  ```typescript
  expect(result).toBeCloseTo(expectedResult, 8);
  ```
  The reference is computed inline from the same arithmetic path that the implementation uses. A `toBe` assertion would pass. Using `toBeCloseTo` with 8 decimal places is weaker than required.

### WT-04: `gear_vandermonde_flat_scratch_regression` — tolerance-based assertions for GEAR-4 coefficients

- **Test**: `src/solver/analog/__tests__/integration.test.ts::gear_vandermonde_regression::gear_vandermonde_flat_scratch_regression`
- **Lines**: 762–769
- **Problem** (also documented as V-03 and G-02):
  ```typescript
  const tol = 1e-6;
  expect(Math.abs(ag[0] - 25 / (12 * h))).toBeLessThan(tol / h);
  ```
  `tol/h = 1.0` for `h=1e-6`. Allows any value within ±1.0 of the reference. The spec required inlined exact Float64 literals and bit-exact `toBe` assertions.

### WT-05: `nicomcof_trap_order2_matches_ngspice_rounding` — tests `integrateCapacitor` path but not `computeNIcomCof` path directly with non-standard xmu

- **Test**: `src/solver/analog/__tests__/integration.test.ts::nicomcof_rounding::nicomcof_trap_order2_matches_ngspice_rounding`
- **Lines**: 678–710
- **Problem**: The spec for Task 3.2.1 requires verifying that `computeNIcomCof` trap order 2 `ag[0]` equals the ngspice rounding formula. The test at lines 696–701 tests `integrateCapacitor` with an external `xmu=1/3`, not `computeNIcomCof` directly with a non-standard xmu. The `computeNIcomCof` function hardcodes `xmu=0.5` (line 443), so the rounding test for `computeNIcomCof` at lines 703–709 uses `xmu=0.5` where `1-xmu=0.5` is exactly representable — this makes both formula variants produce identical results. The test confirms the implementation uses sequential divisions, but it cannot detect a regression where someone reverts to the multiply-then-divide form for `xmu=0.5` because both formulas agree exactly when `xmu=0.5`. The spec called for `xmu=1/3` to create a measurable bit-level difference — but `computeNIcomCof` doesn't expose xmu. The test is thus structurally unable to detect the rounding regression in `computeNIcomCof` itself.

### WT-06: `cktTerr` tests use `bdf2` method for orders >2 when the divided-difference code is unrolled only for orders 1 and 2

- **Test**: Multiple tests including `gear_lte_factor_order_3`, `gear_higher_order_root_is_order_plus_one`
- **Lines**: various
- **Problem**: The `cktTerr` function's divided-difference computation is unrolled only for `order === 1` and the `else` branch (order >= 2 all use the same order-2 math, lines 136–147). When called with `order=3` and `method="bdf2"`, the divided difference computed is a 3rd divided difference (correct for order=2) not a 4th divided difference (correct for order=3). The tests do not assert what the divided difference _is_ for order=3 — they only assert the final timestep output, which cannot distinguish a wrong divided difference from a right one when the reference is also computed using the same unrolled code. This is a pre-existing architectural gap (noted as issue C3 in the cross-reference doc) but the tests do not flag it.

### WT-07: `trap_order2_ccap_with_nonstandard_xmu` — bit-exact `toBe` used correctly

- **Test**: `src/solver/analog/__tests__/integration.test.ts::trap_order2_ccap::trap_order2_ccap_with_nonstandard_xmu`
- This test correctly uses `expect(ccap).toBe(expectedCcap)`. Not a weak test. Removing from count.

(Revised weak test count: WT-01 through WT-06 = 6 weak tests.)

---

## Legacy References

None found.

---

## Out-of-scope Observations (for orchestrator)

**AMD logic remaining in `src/solver/analog/complex-sparse-solver.ts`**: Phase 0 Task 0.1.2 dropped AMD ordering from the real-valued solver (`sparse-solver.ts`). The progress log records this as complete. However, Phase 0 Task 0.1.2's scope as written applied only to `sparse-solver.ts`. A separate `complex-sparse-solver.ts` still contains AMD-related logic (reported by external reviewer at lines ~42-43, 316, 368, 402). This is Phase 0 scope, not Phase 3. The orchestrator should evaluate whether Task 0.1.2 was intended to cover the complex solver as well, and if so, create a remediation task under Phase 0. This reviewer has not read `complex-sparse-solver.ts` as it is outside the Phase 3 review scope.
