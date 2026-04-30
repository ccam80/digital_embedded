# ckt-terr LTE literal drift (Gear factors + trapezoidal slot order)

## Problem

`src/solver/analog/__tests__/ckt-terr.test.ts` is the white-box reference test
for `cktTerr` and `cktTerrVoltage`. Eight assertions fail because the test's
locally-recomputed reference values disagree with what production returns. The
disagreements split cleanly into two sub-fixes.

### Sub-fix A — Gear factor decimal literals

Production exports `GEAR_LTE_FACTORS` using the truncated decimal literals that
ngspice ships verbatim in its `gearCoeff[]` table. The test recomputes its own
"reference" using the closer rational fractions (`2/9`, `3/22`, `10/137`,
`20/343`). These are mathematically nearer the limit but they round to
different IEEE-754 doubles, so the inline-recomputed reference diverges from
production at the LSB and propagates through `factor * ddiff`,
`Math.exp(Math.log(del)/order)`, and `Math.sqrt(del)` into per-assertion
mismatches.

The mismatch is intentional on the production side and explicitly documented
in `src/solver/analog/ckt-terr.ts:33-53` (block comment + the array literal).
Both arrays — `TRAP_LTE_FACTORS` (line 38) and `GEAR_LTE_FACTORS` (line 53) —
are written with ngspice's exact decimal literals to keep parity bit-exact.

### Sub-fix B — order 1 trapezoidal / constant-charge "Infinity" assertion

The legacy job description quoted a failure of the form
`expected Infinity to be 7.000000007`. The current test file does not contain
that literal anywhere — its `dt <= 0` cases assert `Infinity` and pass, and
the constant-charge case (`constant charge history produces finite timestep
(not Infinity) — abstol-gated`) recomputes the GEAR order-1 raw `del`, which
production already returns. There is no remaining slot-order misread of
`(deltaOld, ccap0, ccap1)` left in the file: the 12-arg signature
`cktTerr(dt, deltaOld, order, method, q0, q1, q2, q3, ccap0, ccap1, params)`
is used consistently on every call site (lines 22, 23, 29, 58, 91, 112, 113,
401, 440, 475, 511, 569, 604, 669, 737).

What does still fail under sub-fix A's literals is the cluster of `it(...)`
blocks that bake `2/9`, `3/22`, `10/137`, and `20/343` into a hand-computed
reference. Those are the eight failing assertions listed below.

## Sites

### Production
- `src/solver/analog/ckt-terr.ts:38` — `TRAP_LTE_FACTORS = [0.5, 0.08333333333]`
- `src/solver/analog/ckt-terr.ts:53` — `GEAR_LTE_FACTORS = [0.5, 0.2222222222, 0.1363636364, 0.096, 0.07299270073, 0.05830903790]`
- `src/solver/analog/ckt-terr.ts:33-53` — comment block stating "must match
  ngspice's truncated decimal literals bit-exact, NOT the closer rational
  fractions"

### Test (`src/solver/analog/__tests__/ckt-terr.test.ts`)
Failing assertions (line numbers refer to the right-hand side that recomputes
a "reference" from the rational fraction):

1. `cktTerrVoltage_gear_order2_matches_ngspice` — line 630: `const factorV = 2 / 9;`
2. `gear_lte_factor_order_3` — line 433: `expect(GEAR_LTE_FACTORS[2]).toBe(3 / 22)`; line 460: `const factor = 3 / 22;`
3. `gear_lte_factor_order_5` — line 470: `expect(GEAR_LTE_FACTORS[4]).toBe(10 / 137)`; line 494: `const factor = 10 / 137;`
4. `gear_lte_factor_order_6` — line 506: `expect(GEAR_LTE_FACTORS[5]).toBe(20 / 343)`; line 529: `const factor = 20 / 343;`
5. `order 2 gear: applies sqrt root extraction for nonzero 3rd divided difference` (cktTerrVoltage block) — line 233: `const factor = 2 / 9;`
6. `trapezoidal order 2 and gear order 2 both return positive finite timestep for cubic data` — line 293: `const factor = 2 / 9;`
7. `order 2 linear data gives finite timestep (lteAbstol-gated)` — line 323: `const factor = 2 / 9;`
8. `cktTerr` describe block, `order 1 trapezoidal: returns finite positive timestep for non-trivial charges` — line 45: shadows `gearCoeff` with the truncated decimals (correctly!) and passes; the failing siblings inside the same describe are #2/#3/#4 above.

The eight in-scope failing assertions are #1–#7 plus the pair embedded inside
sub-fix A's order-3 test (the `expect(GEAR_LTE_FACTORS[2]).toBe(3/22)` literal
*and* the `expectedOrder3 = ...` follow-up). Counted as "vitest test cases",
the failing `it(...)` blocks are:

- `cktTerr_formula_fixes > cktTerrVoltage_gear_order2_matches_ngspice`
- `gear_lte_factor_selection > gear_lte_factor_order_3`
- `gear_lte_factor_selection > gear_lte_factor_order_5`
- `gear_lte_factor_selection > gear_lte_factor_order_6`
- `cktTerrVoltage > order 2 gear: applies sqrt root extraction for nonzero 3rd divided difference`
- `cktTerrVoltage > trapezoidal order 2 and gear order 2 both return positive finite timestep for cubic data`
- `cktTerrVoltage > order 2 linear data gives finite timestep (lteAbstol-gated)`
- `cktTerr > order 2 gear: returns sqrt-scaled timestep` (line 78 already uses
  the truncated decimals — passes; not in the failing set)

That is **7 failing tests**, not 8. The brief said 8; it appears to have
double-counted the pair of asserts inside `gear_lte_factor_order_3`. If a
later run reveals an eighth, it will fall under the same sub-fix A category
(rational-fraction reference somewhere we missed).

## Verified ngspice citation

Opened `ref/ngspice/src/spicelib/analysis/cktterr.c` directly. The Gear factor
table is declared as a `static double` array at lines 24–31:

```c
static double gearCoeff[] = {
    .5,
    .2222222222,
    .1363636364,
    .096,
    .07299270073,
    .05830903790
};
```

Trap factor table at lines 32–35:

```c
static double trapCoeff[] = {
    .5,
    .08333333333
};
```

Selection (lines 60–67) and unified `del` formula (line 69) match what
`ckt-terr.ts` already does. The `*timeStep = MIN(*timeStep, del)` MIN
aggregation is line 75; `cktTerr` returns `del` and lets `timestep.ts` do
the MIN — that fold is consistent and not at issue.

The bit-exact decimal literals in the test's correct reference (line 45,
line 78, line 133) match ngspice character-for-character. The bit-broken
references (lines 233, 293, 323, 433/460, 470/494, 506/529, 630) substitute
`2/9`, `3/22`, `10/137`, `20/343` — these are the math behind the truncated
decimals but produce different IEEE-754 doubles.

Quantitative example: in IEEE-754 double,
`2/9 = 0.2222222222222222` (16-digit) vs
ngspice's `0.2222222222` (10-digit) differs by ≈2.2e-11 in the input, which
through `(tol * trtol * delsum) / (denom * delta)` and the cube root maps to a
non-zero ULP shift in the returned `del`, so `expect(result).toBe(reference)`
(strict `===`) fails.

## Sub-fixes

### Sub-fix A.1 — replace `2 / 9` with `0.2222222222`

Sites: ckt-terr.test.ts lines 233, 293, 323, 630 (4 occurrences).

Action: change each `const factor = 2 / 9;` (or `factorV = 2 / 9`) to
`const factor = 0.2222222222;` (or the matching `factorV` name).

**Category: `contract-update`** — production exports `GEAR_LTE_FACTORS` with
ngspice's literal `0.2222222222`; the test was independently recomputing a
"reference" using the rational fraction. Adopting the same literal the
production code (and ngspice) already use is a test-side contract update, not
a numerical change in production.

### Sub-fix A.2 — replace `3 / 22` with `0.1363636364`

Sites: ckt-terr.test.ts lines 433, 460 (2 occurrences inside
`gear_lte_factor_order_3`).

Action: change `expect(GEAR_LTE_FACTORS[2]).toBe(3 / 22)` to
`expect(GEAR_LTE_FACTORS[2]).toBe(0.1363636364)`, and the matching
`const factor = 3 / 22;` to `const factor = 0.1363636364;`.

**Category: `contract-update`** — same rationale as A.1.

### Sub-fix A.3 — replace `10 / 137` with `0.07299270073`

Sites: ckt-terr.test.ts lines 470, 494 (2 occurrences inside
`gear_lte_factor_order_5`).

Action: change `expect(GEAR_LTE_FACTORS[4]).toBe(10 / 137)` to
`expect(GEAR_LTE_FACTORS[4]).toBe(0.07299270073)`, and the matching
`const factor = 10 / 137;` to `const factor = 0.07299270073;`. The regression
guard `expect(GEAR_LTE_FACTORS[4]).not.toBe(5 / 72)` (line 501) is fine —
keep it; both ngspice's truncated decimal and `5/72` are different doubles
(`0.06944...`), so the not-equal assertion still holds.

**Category: `contract-update`**.

### Sub-fix A.4 — replace `20 / 343` with `0.05830903790`

Sites: ckt-terr.test.ts lines 506, 529 (2 occurrences inside
`gear_lte_factor_order_6`).

Action: change `expect(GEAR_LTE_FACTORS[5]).toBe(20 / 343)` to
`expect(GEAR_LTE_FACTORS[5]).toBe(0.05830903790)`, and the matching
`const factor = 20 / 343;` to `const factor = 0.05830903790;`.

**Category: `contract-update`**.

### Sub-fix B — trapezoidal slot-order misread (none required)

The originally reported `expected Infinity to be 7.000000007` symptom does
not exist in the current ckt-terr.test.ts. The 12-arg `cktTerr` signature is
used uniformly; `(deltaOld, ccap0, ccap1)` are all in the right slots. After
the four sub-fix A patches land, run `npm run test:q -- ckt-terr` and confirm
the 7 listed `it(...)` blocks pass. If a residual "Infinity" failure surfaces
that wasn't recomputed-reference-driven, file it as a new item — do not
preemptively guess a slot reorder.

**Category: not applicable (no fix required at this time)**.

## Resolves

- `cktTerr_formula_fixes > cktTerrVoltage_gear_order2_matches_ngspice` (A.1)
- `gear_lte_factor_selection > gear_lte_factor_order_3` (A.2)
- `gear_lte_factor_selection > gear_lte_factor_order_5` (A.3)
- `gear_lte_factor_selection > gear_lte_factor_order_6` (A.4)
- `cktTerrVoltage > order 2 gear: applies sqrt root extraction for nonzero 3rd divided difference` (A.1)
- `cktTerrVoltage > trapezoidal order 2 and gear order 2 both return positive finite timestep for cubic data` (A.1)
- `cktTerrVoltage > order 2 linear data gives finite timestep (lteAbstol-gated)` (A.1)

7 vitest tests. (The brief said 8; recount shows 7. If a CI run shows
otherwise, the 8th will be in the same sub-fix A bucket and the same patch
strategy applies.)

## Tensions / uncertainties

1. **Discrepancy with the brief's failure count.** The brief says 8 failures;
   the file inspection shows 7. The 8th may be a transient CI variance, or it
   may be the regression-guard line 501 which is structured to *not* match
   `5/72` and might fail differently if mistakenly read. Worth a CI run after
   landing A.1–A.4 to confirm zero residuals in this file.

2. **No production change.** All four sub-fixes are test-only edits. The
   `ckt-terr.ts` comment block at lines 33-53 already documents the
   ngspice-bit-exact decision and explicitly warns against substituting the
   rational fractions. Test authors were unaware of (or pre-dated) that
   comment.

3. **The ngspice decimals are not the most-accurate doubles for `2/9`,
   `3/22`, etc.** This is acknowledged in `ckt-terr.ts:43-46`. We are choosing
   parity with ngspice's printed source over mathematical optimality. That
   choice is already in production and not subject to debate within this
   spec; the spec simply propagates that decision into the test.

4. **`cktTerrVoltage` voltage path is independent.** Note that
   `cktTerrVoltage` uses the same `GEAR_LTE_FACTORS` array (ckt-terr.ts:332),
   so all four sub-fixes apply equally to its tests. No separate voltage-side
   constant is needed.
