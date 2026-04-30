# Potentiometer middle-node diagonal expectation

## Category
`contract-update`

## Resolves (1 vitest test)
- `potentiometer_load_dcop_parity > wiper=0.5 10kΩ pot G_top=G_bottom=1/5000 bit-exact`
  in `src/components/passives/__tests__/potentiometer.test.ts:220-275`,
  failing at line 258 with `expected 0.0002 to be 0.0004`.

## Sites
- Test: `src/components/passives/__tests__/potentiometer.test.ts` lines 219-276
- Production: `src/components/passives/potentiometer.ts` lines 168-258 (`AnalogPotentiometerElement`)

## Verified ngspice citation

`ref/ngspice/src/spicelib/devices/res/resload.c` lines 16-41 (function
`RESload`):

```
*(here->RESposPosptr) += m * here->RESconduct;
*(here->RESnegNegptr) += m * here->RESconduct;
*(here->RESposNegptr) -= m * here->RESconduct;
*(here->RESnegPosptr) -= m * here->RESconduct;
```

Each resistor instance stamps `+G` at `(pos,pos)` and `(neg,neg)`,
and `-G` at `(pos,neg)` and `(neg,pos)`. The potentiometer is two
independent ressetup/resload instances sharing the wiper as the
"neg" of the top resistor and the "pos" of the bottom resistor.
Per-resistor pair count is exactly 4 stamps — no double-count.

## Production code is correct

`src/components/passives/potentiometer.ts:198-215` calls
`solver.allocElement` 8 times in `setup()` (4 per sub-resistor),
and `load()` at lines 227-241 calls `stampElement` 8 times
matching the four resload stamps per sub-resistor. Mapping:

| ngspice (per-resistor) | digiTS R_AW             | digiTS R_WB             |
|------------------------|-------------------------|-------------------------|
| `+G` at (pos,pos)      | `_hAW_PP` = (A,A)       | `_hWB_PP` = (W,W)       |
| `+G` at (neg,neg)      | `_hAW_NN` = (W,W)       | `_hWB_NN` = (B,B)       |
| `-G` at (pos,neg)      | `_hAW_PN` = (A,W)       | `_hWB_PN` = (W,B)       |
| `-G` at (neg,pos)      | `_hAW_NP` = (W,A)       | `_hWB_NP` = (B,W)       |

Diagonal totals (with pinNodes A=1, B=2, W=3):
- (1,1) = +G_AW                       = 1/5000 = 0.0002
- (3,3) = +G_AW + G_WB                = 2/5000 = 0.0004   ← middle node
- (2,2) = +G_WB                       = 1/5000 = 0.0002

This matches the ngspice contract exactly. The 8 stamps the test sees at
position 0.5 are all `±0.0002`, never `0.0004` — there is no doubled
single stamp anywhere; the `0.0004` only appears as the *sum* of two
separate stamps that land on the same matrix slot during sparse
assembly.

## Test bug — index swap

The failing assertion at line 258 of the test is:

```
const eBB = stamps.find((e) => e.row === 2 && e.col === 2);
expect(eBB!.value).toBe(NGSPICE_G_REF + NGSPICE_G_REF);  // 0.0004
```

The comment block at lines 240-249 tells the author's mental model:
they thought `pinNodeIds = [A, B, W]` and that the middle (shared)
node is therefore `pinNodes[1] = B = 2`. That model is wrong on two
counts:

1. The factory at `potentiometer.ts:264-268` reads pin nodes from a
   `Map` named by pin label (`"A"`, `"B"`, `"W"`), not by positional
   index. There is no `pinNodeIds` array in the production element.
2. The wiper (the shared middle node) is `W`, not `B`. The component
   is "two series resistors sharing the wiper", and the wiper pin is
   labelled `W` — the test's pinNodes map at line 228 binds `W=3`,
   so `(3,3)` is the middle-node diagonal, not `(2,2)`.

The capture solver records raw 1-based node ids passed to
`allocElement`, so:
- Stamps that land at (1,1) are A diagonal: only G_AW → `0.0002`.
- Stamps that land at (2,2) are B diagonal: only G_WB → `0.0002`.
- Stamps that land at (3,3) are W diagonal: G_AW + G_WB = `0.0004`.

The test asserts `eBB(2,2) === 0.0004` and `eWW(3,3) === 0.0002` —
both backwards. The implementation is correct; the test got the
W ↔ B labelling swapped.

## Implementation fix

Update the test to reflect the actual node-label assignment. Two
changes in `src/components/passives/__tests__/potentiometer.test.ts`
inside the `wiper=0.5 10kΩ pot G_top=G_bottom=1/5000 bit-exact` test:

- Line 256-258: swap the `eBB` (2,2) and `eWW` (3,3) assertions:
  - `(2,2)` should be `NGSPICE_G_REF` (single-segment diagonal)
  - `(3,3)` should be `NGSPICE_G_REF + NGSPICE_G_REF` (shared wiper)

- Lines 264-274: update the off-diagonal cross-term comments and
  finds. The cross-terms in the actual code are:
  - Top resistor: `(1,3)` and `(3,1)` cross terms = `-G_AW`
  - Bottom resistor: `(3,2)` and `(2,3)` cross terms = `-G_WB`

  The test currently looks for `(1,2)/(2,1)` (A↔B) and `(2,3)/(3,2)`
  (B↔W) cross terms. The A↔B finds will return `undefined` because
  there is no direct A-B stamp in a wiper-sharing potentiometer.

The bare assertions (`stamps_two_conductance_pairs`,
`position_0_gives_full_resistance_on_bottom`,
`position_1_gives_full_resistance_on_top`) at lines 60-147 search
with disjunction filters that happen to match correctly, so they
pass — they tolerated the same conceptual confusion without
exposing it.

## Tensions / uncertainties

- This is a test-only fix. No other test relies on the doubled
  `(2,2)` value: the bare-assertion tests use `Math.abs(s[2] - 0.0002)`
  on disjunction-filtered stamp subsets, which is independent of
  whether the diagonal sum landed at row 2 or row 3.
- The category is `contract-update` (the test's contract was wrong)
  rather than `architecture-fix` because the production stamp shape
  matches `resload.c` bit-for-bit and the test's stated NGSPICE_G_REF
  expectation is exactly what the production code produces — it just
  produces it at a different matrix coordinate than the test asserts.
- Reviewer should verify the analog DCOP parity test (line 219) is
  the only test in this file that asserts on specific row/col indices
  rather than on disjunctive subsets; otherwise the fix may need to
  cascade.
