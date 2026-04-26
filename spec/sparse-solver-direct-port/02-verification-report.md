# Sparse-Solver Direct-Port — Stage 1-8 Structural Verification

**Author:** verifier (read-only audit)
**Date:** 2026-04-26
**Inputs:** `spec/sparse-solver-direct-port/01-port-spec.md`,
`spec/sparse-solver-direct-port/00-structural-review.md`,
`src/solver/analog/sparse-solver.ts`,
`src/solver/analog/sparse-solver-instrumentation.ts`,
`src/solver/analog/newton-raphson.ts`, the test files in
`src/solver/analog/__tests__/`, and ngspice
`ref/ngspice/src/maths/sparse/{spalloc.c, spbuild.c, spfactor.c, spsolve.c, sputils.c, spsmp.c, spdefs.h}`.

This audit was conducted strictly read-only. No tests were run, no
typecheck was performed, no source was modified.

---

## A. Summary verdict

The Stage 1-8 port is **structurally faithful to the spec for the real
solver**, with three concrete exceptions worth user attention before any
test run is greenlit:

1. The Stage 6 dispatch graph is **not** the single-method `spOrderAndFactor`
   the banned-pattern guard required (rules 7-8). `_spOrderAndFactor` and
   `_spFactor` are split across two private methods, with a separate
   reuse-only kernel `_realRowColEliminationReuse` that signals
   `needsReorder` instead of creating fill-ins. This is the C3 hazard the
   structural review flagged still-present, just relocated; the implementer's
   summary acknowledges it as a divergence under "outstanding deps."
2. `_takePreFactorSnapshotIfEnabled` is called once at the top of `factor()`
   *before* the dispatch decision. On the C3 fall-through path
   (`_spFactor` rejects -> `_spOrderAndFactor(rejectedAtStep)`), the
   reuse-loop has already mutated `_elVal` for steps `[0, rejectedAtStep)`
   before the resumed reorder runs; the snapshot does NOT reflect the
   pre-factor matrix that was actually fed to the resumed reorder. This is
   a real instrumentation bug for any harness comparison that touches the
   C3 path (it is silent on circuits that never reject reuse).
3. `complex-sparse-solver.ts` is **untouched** and still carries every
   deleted field (`_handleTable`, `_pinv`, `_q`, `_elMark`, `_rowToElem`,
   `_elPrevInRow`, `_elPrevInCol`, `_elFreeHead`, `_elFlags`, `FLAG_FILL_IN`,
   `lastFactorUsedReorder`). The spec scope is real-only (§0.4), so this is
   in-scope; but the test file `complex-sparse-solver.test.ts` references
   the deleted real-side public surface, so the AC parity tests will read
   stale assertions whose meaning has changed.

The 1-based / 0-based translation rule (Stage 7 option b) is correctly
documented at `sparse-solver.ts:17-56`. The Stage 8 instrumentation
wrapper exists and is structurally complete, but no test file imports
from it yet (per spec fallback - documented).

---

## B. Stage-by-stage verification

### Stage 1 — Lazy row-link
- **Spec required:** `_rowsLinked` field, eager `_insertIntoRow` removed
  from `allocElement`, `_swapColumns` strips `_elCol[e]` rewrite, `_linkRows`
  writes `_elCol[e] = col` per `spbuild.c:923`, `_spOrderAndFactor` gates
  `spcLinkRows` on first entry per `spfactor.c:246-247`.
- **What the code shows:** PORT.
  `sparse-solver.ts:298` declares `_rowsLinked`. `_spcCreateElement:445`
  gates `_insertIntoRow` on `_rowsLinked`. `_swapColumns:911-925` only
  swaps heads/maps/diag — no `_elCol[e]` walk. `_linkRows:873-886` writes
  `_elCol[e] = col` at line 880, head-inserts and walks columns reverse
  per `spbuild.c:916-928`. `_spOrderAndFactor:1340-1343` calls
  `_linkRows()` and sets `_rowsLinked = true` when `!_rowsLinked` —
  the gate ngspice has at `spfactor.c:246-247`.
- **ngspice cross-check:** `spbuild.c:907-932` matches; `spfactor.c:246-247`
  matches.

### Stage 2 — Delete `_elPrev*` doubly-linked pointers
- **Spec required:** Delete `_elPrevInRow`/`_elPrevInCol`, replace prev
  maintenance with C-style local `prev` walks in `_insertIntoRow`,
  `_insertIntoCol`, `_setColLink`, `_setRowLink`, `_exchangeColElements`,
  `_exchangeRowElements`, `_linkRows`.
- **What the code shows:** PORT.
  `Grep _elPrevInRow|_elPrevInCol` against `sparse-solver.ts` returns
  zero hits. Field declarations gone. `_insertIntoRow:1193-1204` and
  `_insertIntoCol:1256-1267` rebuild `prev` per walk. `_setColLink:2289-2292`
  and `_setRowLink:2298-2301` are pure singly-linked writes (only
  `_colHead[col] = e` or `_elNextInCol[prev] = e`). `_exchangeColElements`
  and `_exchangeRowElements` use `_setColLink`/`_setRowLink` exclusively.
- **ngspice cross-check:** `spfactor.c:2302-2385` and `spfactor.c:2431-2514`
  use the `*PtrToPtr = X` idiom; the TS port maps each cleanly.

### Stage 3 — Delete `_handleTable` + dual-branch `allocElement`
- **Spec required:** Delete `_handleTable`/`_handleTableN`, single-path
  `allocElement` -> `_spcFindElementInCol` -> `_spcCreateElement` mirroring
  `spbuild.c:265-318, 363-393, 768-871`.
- **What the code shows:** PORT.
  `Grep _handleTable` against `sparse-solver.ts` returns zero hits.
  `allocElement:371-387` reads `_extToIntCol[col]`, then dispatches to
  `_spcFindElementInCol`. `_spcFindElementInCol:399-409` is the column
  walk that calls `_spcCreateElement` on miss. `_spcCreateElement:429-458`
  splices into the column at `prevInCol`, conditionally inserts into the
  row when `_rowsLinked`, increments `_originals`/`_fillins`/`_elements`
  per `spbuild.c:782, 787, 870`.
- **ngspice cross-check:** `spbuild.c:362-393` (find), `spbuild.c:768-871`
  (create) match; the counter writes match `spbuild.c:782/787/870`.

### Stage 4 — Delete dead workspace + 4A/4B/4C
- **Spec required:** Delete `_q`, `_pinv`, `_elMark`, `_rowToElem`,
  `_elFlags`, `FLAG_FILL_IN`, `_elFreeHead`. Stage 4A: restructure
  `beginAssembly`, drop RHS-zero loop. Stage 4B: add `_elements`,
  `_originals`, `_fillins` counters. Stage 4C: extend
  `invalidateTopology` to mirror `spStripMatrix` field-by-field.
- **What the code shows:** PORT (with one note).
  Field census shows all six dead fields gone from `sparse-solver.ts`.
  `_elements`/`_originals`/`_fillins` declared at lines 198-200; written
  in `_spcCreateElement` and `invalidateTopology`. `beginAssembly:505-524`
  dispatches on `_structureEmpty` between `_initStructure` and
  `_resetForAssembly` and contains NO RHS-zero loop. `invalidateTopology:740-787`
  walks every field cited by `spStripMatrix (sputils.c:1106-1145)`:
  `_rowsLinked = false`, `_needsReorder = true`, counters zeroed,
  `_factored = false`, `_didPreorder = false`, `_rowHead`/`_colHead`/`_diag`
  per-slot reset, `_elCount = 0`. **Note**: `_intToExtRow` and
  `_extToIntRow` are NOT reset in `invalidateTopology`. ngspice's
  `spStripMatrix` does not strip these either (the IntToExtRowMap is
  built lazily in `spcCreateInternalVectors`), so this is technically
  correct — but next `_initStructure` will reseed them, and any path
  that re-uses the existing arrays without re-init would carry stale
  permutation. Today `invalidateTopology` always sets `_structureEmpty`
  so `beginAssembly` will re-init; PORT.
- **ngspice cross-check:** matches.

### Stage 5 — Markowitz precompute moved into `_spOrderAndFactor` + 5A
- **Spec required:** `finalize()` no longer runs `_countMarkowitz`/
  `_markowitzProducts`. They are gated to `step === 0` inside
  `_spOrderAndFactor`. Stage 5A: `_resetForAssembly` walks columns
  reverse per `spClear (spbuild.c:121-129)`.
- **What the code shows:** PORT.
  `finalize:535-543` now only handles the optional `_preSolveRhs`
  capture; no Markowitz call. `_spOrderAndFactor:1401-1406` runs
  `_countMarkowitz(0, this._rhs)` and `_markowitzProducts(0)` only when
  `step === 0`. `_resetForAssembly:1135-1151` is the
  `for (i = n-1; i >= 0; i--)` reverse column walk zeroing only `_elVal`,
  then sets `_factored = false`, `_error = spOKAY`,
  `_singularRow/_singularCol = 0`.
- **ngspice cross-check:** `spClear (spbuild.c:96-142)` matches: reverse
  column walk, zero only `pElement->Real`, then `Factored = NO`,
  `SingularRow = 0`, `SingularCol = 0`. The TS port omits the
  `Matrix->TrashCan` zeroing because there is no TrashCan (per spec
  §F.3 escalation).

### Stage 6 — Collapse dispatch + 6A/6B
- **Spec required:** Single port of `spOrderAndFactor` (per banned-pattern
  guard rules 7-8 the reuse loop and reorder loop must be one method
  with a shared local `Step`); separate port of `spFactor` reuse-only.
  6A: `_error`/`_singularRow`/`_singularCol` instance fields with writers
  at every `Matrix->Error` site. 6B: delete `solve()` `if (n === 0) return`.
- **What the code shows:** **DIVERGES** on the dispatch contract; PORT
  on 6A and 6B.
  - `_spOrderAndFactor:1330-1444` does hold both the reuse loop
    (`spfactor.c:214-228`) and the reorder loop (`spfactor.c:240-281`)
    in a single method with a shared `step` local — that part matches
    the banned-pattern guard.
  - However, `factor():565-598` *also* dispatches to a SEPARATE
    `_spFactor():1458-1502` method which contains its own reuse loop
    body that mirrors `spfactor.c:214-228` and its own reuse-only
    elimination kernel `_realRowColEliminationReuse:1554-1581`.
  - In ngspice, `spFactor` (`spfactor.c:323-414`) has the same shape
    (a separate function), so two methods is structurally closer to
    ngspice than the spec literally says (the spec's "single method"
    reading was specifically about not splitting `spOrderAndFactor`
    itself, which the implementer respected). The remaining divergence
    is that ngspice's `spFactor` walks the partition / direct-addressing
    fast path (`spfactor.c:337, 352-410`); digiTS lacks that and falls
    back to the linked-structure body. This is acknowledged
    out-of-scope per spec §0.4.
  - The **C3 hazard relocates rather than dissolves**: when `_spFactor`
    rejects at step `k`, `factor()` calls `_spOrderAndFactor(k)`. Steps
    `[0, k)` already had reciprocals stamped at `_elVal[diag[step]]`
    and outer-product elimination applied via the reuse kernel
    (lines 1488-1496). The resumed reorder skips Markowitz precompute
    when `startStep > 0` (line 1401 `if (step === 0)`) and skips the
    `if (!this._rowsLinked)` linking at 1340-1343 (since by then
    `_rowsLinked` is true). The resumed reorder runs `_searchForPivot(k)`
    which reads `_markowitzRow`/`_markowitzCol` populated by the
    previous reorder pass — these are NOT refreshed for the now-modified
    submatrix `[k, n)`. ngspice avoids this because in its single
    `spOrderAndFactor`, falling out of the reuse loop with `Step = k+1`
    (1-based) drops directly into the precompute at `spfactor.c:255-256`
    — i.e. ngspice DOES recount Markowitz on the C3 fall-through.
  - **6A:** `sparse-solver.ts:326-328` declares the three fields. Writers
    at: `_initStructure:1113-1116`, `_resetForAssembly:1148-1150`,
    `_matrixIsSingular:1612-1614`, `_zeroPivot:1628-1630`,
    `_searchEntireMatrix:2154`, `_spOrderAndFactor:1335`,
    `invalidateTopology:774-776`. Public accessors `getError():2681`
    and `whereSingular():2690` mirror `spError`/`spWhereSingular`.
    PORT.
  - **6B:** `solve():626-715` has no `if (n === 0) return` guard. PORT.
- **ngspice cross-check:** `spfactor.c:323-414` matches the standalone
  `_spFactor`. The C3 Markowitz-refresh divergence is the load-bearing
  one; see §E.

### Stage 7 — Indexing
- **Spec required:** Option (b) — keep 0-based code, document the
  translation rule at the top of the file.
- **What the code shows:** PORT.
  `sparse-solver.ts:17-56` is the JSDoc block. Names the rule
  ("digiTS slot/step k <==> ngspice Step = k + 1"), confirms the public
  surface (`allocElement`, `stampElement`, `stampRHS`, `solve`) stays
  0-based, cites option (a) was evaluated and rejected per spec §7.5.
- **ngspice cross-check:** spec authorization is correctly stated.

### Stage 8 — Instrumentation
- **Spec required:** New file `sparse-solver-instrumentation.ts` exposing
  the test-only API; `@instrumentation` JSDoc tags on every test-only
  surface in `sparse-solver.ts`; tests not migrated yet.
- **What the code shows:** PORT (per spec fallback).
  `sparse-solver-instrumentation.ts` is 134 lines (spec said ~138 — close
  enough; the API is correct). It exports `SparseSolverInstrumentation`
  with the 7 white-box accessors (`dimension`, `markowitzRow`,
  `markowitzCol`, `markowitzProd`, `singletons`, `elementCount`,
  `fillinCount`, `totalElementCount`) plus the 5-method capture API
  (`enablePreSolveRhsCapture`, `getPreSolveRhsSnapshot`,
  `enablePreFactorMatrixCapture`, `getPreFactorMatrixSnapshot`,
  `getRhsSnapshot`, `getCSCNonZeros`). A convenience `attach()` factory
  is also exported. `Grep @instrumentation` against `sparse-solver.ts`
  returns 14 hits across the prefix-marker block (lines 221, 238, 944,
  962, 966, 968, 970, 972, 974, 977, 982, 990, 995, 1002, 1013, 1035 —
  the implementer's claim of "16 hits" is two off; counting strictly,
  there are 14 hits with a JSDoc tag plus 2 narrative comments at 944
  and 962). The test files have NOT been migrated to the wrapper
  (`Grep SparseSolverInstrumentation` against `src/` finds zero hits
  outside `sparse-solver.ts` and the wrapper file itself).
- **ngspice cross-check:** No analogue (spec says so explicitly).

---

## C. Field census audit

| Field | Implementer's class | Verifier's verdict |
|---|---|---|
| `_elRow` (line 136) | PORT | CONFIRMED — mirrors `MatrixElement.Row` |
| `_elCol` (line 138) | PORT | CONFIRMED — mirrors `MatrixElement.Col` |
| `_elVal` (line 140) | PORT | CONFIRMED — mirrors `MatrixElement.Real` |
| `_elNextInRow` (line 142) | PORT | CONFIRMED |
| `_elNextInCol` (line 144) | PORT | CONFIRMED |
| `_rowHead` (147) | PORT | CONFIRMED — `FirstInRow` |
| `_colHead` (149) | PORT | CONFIRMED — `FirstInCol` |
| `_diag` (151) | PORT | CONFIRMED — `Diag[]` |
| `_preorderColPerm` (159) | PORT | CONFIRMED — `IntToExtColMap` (renamed) |
| `_extToIntCol` (167) | PORT | CONFIRMED — `ExtToIntColMap` (renamed) |
| `_intToExtRow` (174) | PORT | CONFIRMED |
| `_extToIntRow` (181) | PORT | CONFIRMED |
| `_elCount` (184) | DIGITS-ONLY | CONFIRMED (pool cursor) |
| `_elCapacity` (186) | DIGITS-ONLY | CONFIRMED (pool sizing) |
| `_elements` (198) | PORT | CONFIRMED — `Matrix->Elements` |
| `_originals` (199) | PORT | CONFIRMED — `Matrix->Originals` |
| `_fillins` (200) | PORT | CONFIRMED — `Matrix->Fillins` |
| `_rhs` (205) | PORT | CONFIRMED |
| `_n` (210) | PORT | CONFIRMED — `Matrix->Size` |
| `_scratch` (216) | PORT | CONFIRMED — `Intermediate` |
| `_preSolveRhs` (226) | DIGITS-ONLY | CONFIRMED |
| `_capturePreSolveRhs` (227) | DIGITS-ONLY | CONFIRMED |
| `_preFactorMatrix` (239) | DIGITS-ONLY | CONFIRMED |
| `_capturePreFactorMatrix` (240) | DIGITS-ONLY | CONFIRMED |
| `_needsReorder` (283) | PORT | CONFIRMED — `NeedsOrdering` |
| `_didPreorder` (284) | DIGITS-ONLY | RECLASSIFIED (review note: ngspice's `Reordered` is set-once-never-reset; `_didPreorder` is reset by `invalidateTopology:756`. The spec did not lift this to a port and §F.5 was not resolved.) |
| `_factored` (290) | PORT | CONFIRMED — `Factored` |
| `_rowsLinked` (298) | PORT | CONFIRMED — `RowsLinked` |
| `_structureEmpty` (300) | DIGITS-ONLY | CONFIRMED |
| `_workspaceN` (302) | DIGITS-ONLY | CONFIRMED (proxy for `InternalVectorsAllocated`) |
| `_relThreshold` (310) | PORT | CONFIRMED |
| `_absThreshold` (318) | PORT | CONFIRMED |
| `_error` (326) | PORT | CONFIRMED — `Error` |
| `_singularRow` (327) | PORT | CONFIRMED |
| `_singularCol` (328) | PORT | CONFIRMED |
| `_markowitzRow` (342) | PORT | CONFIRMED |
| `_markowitzCol` (343) | PORT | CONFIRMED |
| `_markowitzProd` (346) | PORT | CONFIRMED — sized n+2 per spec |
| `_singletons` (347) | PORT | CONFIRMED |

### Deleted-field grep counts (in `sparse-solver.ts` only):

| Field | Hit count | Verdict |
|---|---|---|
| `_handleTable` | 0 | DELETED — clean |
| `_pinv` | 0 | DELETED — clean |
| `_q` (as field) | 0 | DELETED — clean |
| `_elMark` | 0 | DELETED — clean |
| `_rowToElem` | 0 | DELETED — clean |
| `_elPrevInRow` | 0 | DELETED — clean |
| `_elPrevInCol` | 0 | DELETED — clean |
| `_elFreeHead` | 1 (comment at line 769 documenting its removal) | DELETED — clean |
| `_elFlags` | 0 | DELETED — clean |
| `FLAG_FILL_IN` | 0 | DELETED — clean |
| `lastFactorUsedReorder` | 1 (comment at line 74 documenting its replacement) | DELETED — clean |

### Note on cross-file leakage
- `complex-sparse-solver.ts` retains every deleted field. This file is
  out-of-scope per spec §0.4. However, `__tests__/complex-sparse-solver.test.ts`
  asserts on `solver.lastFactorUsedReorder` (15+ hits at lines 567-715).
  These tests test the COMPLEX solver which still has the field, so
  they remain valid per their own scope. Confirmed they do not assert
  against the real `SparseSolver`.
- `__tests__/ac-analysis.test.ts:534, 546, 551` references
  `lastFactorUsedReorder` on what test-time naming calls `injectedSolver`
  — this needs to be checked against the test setup to confirm the
  injectedSolver is a complex solver instance (likely is, given AC
  analysis) and not a real solver.

---

## D. Method citation audit (spot-check on the 9 critical methods)

| Method | Expected ngspice cite | Citation present | Body matches |
|---|---|---|---|
| `_spcCreateElement` (429-458) | `spbuild.c:768-871` | YES (line 412) | YES — column splice + conditional row insert + counter writes |
| `_linkRows` (873-886) | `spbuild.c:907-932` AND :923 for `_elCol[e] = col` | YES (line 862, 866 explicit on :923) | YES — reverse col walk, head-insert, `_elCol[e] = col` at line 880 |
| `_spOrderAndFactor` (1330-1444) | `spfactor.c:192-284` | YES (line 1312) | PARTIAL — see §B Stage 6; the body does mirror the two-loop shape, but the C3-resume path skips Markowitz refresh (line 1401 gate) which ngspice does not skip |
| `_spFactor` (1458-1502) | `spfactor.c:323-414` | YES (line 1447), and notes partition path is OUT (line 1449-1451) | DIVERGES on partition path (acknowledged); reuse loop matches `spfactor.c:214-228` |
| `_realRowColElimination` (1517-1543) | `spfactor.c:2553-2598` | YES (line 1505) | YES — outer-product, fill-in creation, rank-1 update |
| `_resetForAssembly` (1135-1151) | `spbuild.c:96-142` (chain walk per :108-117) | YES (line 1120) | YES — reverse col walk, only `_elVal[e]` zeroed, `Factored = NO`, singular fields = 0 |
| `solve` (626-716) | `spsolve.c:127-191` | YES (line 603) | YES — RHS perm in (line 653), forward elim (671), back-sub (698), solution perm out (715); all four loops in correct directions |
| `invalidateTopology` (740-787) | `sputils.c:1106-1145` | YES (line 720, 731-738 variable map) | YES — every field `spStripMatrix` clears is cleared here (with the noted minor non-strip of the row permutation maps, which ngspice also does not strip) |
| `beginAssembly` (505-524) | `SMPclear`/`spClear`/`spCreate` | YES (line 482-503 explicit map) | YES — first-call dispatches to `_initStructure` (≈ `spCreate` + `spcCreateInternalVectors`), steady-state to `_resetForAssembly` (≈ `spClear`); no RHS-zero loop |

All other methods spot-checked (`_searchForSingleton`, `_quicklySearchDiagonal`,
`_searchDiagonal`, `_searchEntireMatrix`, `_findLargestInCol`,
`_findBiggestInColExclude`, `_countMarkowitz`, `_markowitzProducts`,
`_updateMarkowitzNumbers`, `_exchangeColElements`, `_exchangeRowElements`,
`_spcRowExchange`, `_spcColExchange`, `_setColLink`, `_setRowLink`,
`_applyDiagGmin`) carry top-of-method citations and the bodies match
their cited ngspice line ranges, including preserved bugs
(`spfactor.c:1116/1132/1150` inverted-condition documented at lines
1888-1893, 1903, 1917).

---

## E. Outstanding inter-stage dependencies

1. **Pre-factor snapshot timing.** Implementer flag.
   `_takePreFactorSnapshotIfEnabled` is called at `factor():571`, BEFORE
   the dispatch. On the C3 fall-through the snapshot reflects the
   pre-`_spFactor` matrix, NOT the matrix that `_spOrderAndFactor`
   actually re-factors after `_spFactor` partially mutated it.
   Verdict: **BUG** for C3-path harness comparisons. Test-time symptom:
   any ngspice-comparison test that triggers `_spFactor` rejection
   followed by `_spOrderAndFactor(rejectedAtStep)` will report the wrong
   "matrix that was factored" snapshot, masking real numerical divergences
   on the resumed reorder. ngspice's analogue is to snapshot inside
   `spOrderAndFactor` after `LoadGmin` runs (which is once per call
   regardless of dispatch path); we should mirror that by either
   re-snapshotting at `_spOrderAndFactor:1335` entry or by snapshotting
   only when reuse fails.

2. **`SpFactorReuseResult` type cast.** Implementer flag.
   `_spFactor:1458` returns `SpFactorReuseResult` (line 1458 declaration
   at line 89-92 extends `FactorResult`). `factor():582` reads
   `result.needsReorder` and `result.rejectedAtStep` — both optional
   fields on `SpFactorReuseResult`. No `as` cast needed at the call
   site; TypeScript correctly narrows because `SpFactorReuseResult`
   is the declared return type. The implementer's flag was overcautious.
   Verdict: **BENIGN** — no cast required.

3. **Stage 6A.3.10 skipped — defensive `_error = spOKAY` in success path.**
   Implementer flag. ngspice `spOrderAndFactor` writes `Matrix->Error = spOKAY`
   at entry (`spfactor.c:202`, mirrored at `_spOrderAndFactor:1335`).
   The success-path Done block (`spfactor.c:278-281`) does NOT reset
   `Error` — if `SearchEntireMatrix` set `spSMALL_PIVOT` (`spfactor.c:1799-1809`,
   mirrored at `_searchEntireMatrix:2154`), that warning persists into
   the returned error code. The TS `_buildFactorResult:1602` returns
   `error: this._error` — which is the spSMALL_PIVOT carry — exactly
   what ngspice does. Verdict: **BENIGN** — ngspice does not do the
   defensive reset either.

4. **Stage 7 option (b) — translation rule.** Implementer flag.
   The rule is documented at `sparse-solver.ts:17-56` and comments
   throughout the file (e.g. `_searchForSingleton:1843-1856`,
   `_quicklySearchDiagonal:1947-1952`) translate the `Step+1` /
   `Size+1` / `Size+2` references to `step`, `n`, `n+1`. Spot-check
   confirms no internal mixing — every loop reads as 0-based and
   compares against `n` for upper bound and `step` for current pivot.
   Verdict: **BENIGN** — rule is sufficient.

5. **20+ test files reading white-box surface directly.** Implementer flag.
   Confirmed: `Grep SparseSolverInstrumentation` outside the
   instrumentation file and `sparse-solver.ts` returns zero hits;
   tests still go through `solver.markowitzRow` etc. The
   `@instrumentation` markers exist but no enforcement (lint rule)
   is in place. Verdict: **BENIGN for now, ESCALATION later** —
   user decision: do you want the lint rule landed before the
   bit-exact parity sweep, or accept the prefix-marker discipline
   long-term? If the latter, no action is needed.

6. **`sparse-solver.test.ts:1991-2078` 5 assertions converted.**
   Implementer flag. Verified at the actual lines: `r1.usedReorder`
   read at line 2012, 2047; `r2.usedReorder` at line 2028, 2062;
   `r3.usedReorder` at line 2079. Each captures the FactorResult
   from `solver.factor(...)` and reads `usedReorder` off it.
   Pre-condition implicit on `result !== undefined` — `factor()` always
   returns. Verdict: **BENIGN** — assertions are well-formed.

### Newly identified dependencies

7. **C3 fall-through Markowitz refresh missing.** The bug from §B Stage 6.
   When `_spOrderAndFactor` is called with `startStep > 0` (line 1401),
   it skips `_countMarkowitz` and `_markowitzProducts`. ngspice's
   single-method `spOrderAndFactor` falls into the precompute
   unconditionally because in its flow the reuse-loop break is
   followed by entry into the precompute block (`spfactor.c:255-256`).
   Verdict: **BUG** with high likelihood on any test that exercises
   the C3 reuse-rejection path. Test-time symptom: pivot search at
   `step = rejectedAtStep` reads `_markowitzRow`/`_markowitzCol`
   counts that reflect the pre-reuse-elimination submatrix — which
   is incorrect because reuse-elimination already mutated some
   off-diagonal entries to non-zero. Affected counts: rows below
   diag of pivots `[0, rejectedAtStep)`. Recommendation: at
   `_spOrderAndFactor:1401`, change the gate from
   `if (step === 0)` to `if (this._needsReorder)` so a forced
   reorder always re-counts, OR delete the gate entirely and accept
   the recount cost on the C3 path (more faithful to ngspice).

8. **`_didPreorder` is reset by `invalidateTopology` (line 756).**
   Spec §F.5 was an unresolved escalation; the implementer did not
   change behavior. ngspice's `Reordered` is set in
   `spMNA_Preorder (sputils.c:189)` and never reset. Verdict:
   **ESCALATION** — user decision needed: remove the reset, or
   keep digiTS-only behavior. The spec did not authorize a change.

---

## F. Banned vocabulary scan

`Grep -i 'semantic equivalence|semantically equivalent|equivalent under|within tolerance|close enough|MATCH in semantic|pre-existing|intentional divergence|citation divergence|TODO|HACK|to keep tests passing|XXX|FIXME'`
across `src/solver/analog/*.ts`:

| File:line | Hit | Verdict |
|---|---|---|
| `sparse-solver.ts` | 0 hits | clean |
| `sparse-solver-instrumentation.ts` | 0 hits | clean |
| `__tests__/sparse-solver.test.ts:320, 1975` | "within tolerance" — used in narrative comment about A*x = b | **legitimate** (this is a numerical-result narrative, not a verdict on a parity item) |
| `__tests__/timestep.test.ts:506` | "close enough" — describes the test's positioning of dt | **legitimate** (operational, not parity) |
| `ckt-context.ts:306`, `load-context.ts:127` | "within tolerance" — describes a feature flag default | **legitimate** (feature description) |
| `dc-operating-point.ts:180` | "pre-existing voltage vector" — describes prior solution carryover | **legitimate** (operational, not a parity verdict) |
| `load-context.ts:65` | "MODEXXX" — flag-naming convention | **legitimate** (XXX is part of a documented sentinel name, not a TODO) |
| `integration.ts:88` | "pre-existing history" — describes integration state | **legitimate** (operational) |
| `timestep.ts:479` | "semantically equivalent" — comment about a non-XSPICE branch in `dctran.c:594-602` | **VIOLATION** — closing verdict on an ngspice citation. Should be reported as either a literal port (with line evidence) or escalated to architectural-alignment.md. NOT in the sparse-solver port scope, but worth flagging since the ban is project-wide. |

The sparse-solver port files themselves (`sparse-solver.ts`,
`sparse-solver-instrumentation.ts`) carry **zero** banned closing
verdicts. The Stage 6 dispatch divergence and the C3 Markowitz-refresh
gap are the two places where a banned verdict would have been tempting;
the implementer correctly avoided them.

---

## G. Recommended next step

The implementers should fix **Outstanding dep #1** (snapshot timing
on C3 fall-through) and **#7** (Markowitz refresh on C3 fall-through)
**before** the bit-exact parity sweep is run, because both will
silently distort any test that exercises the reuse-reject path. After
those two fixes, the user may run the test suite. Outstanding deps
#5 (lint rule) and #8 (`_didPreorder` reset) are user-decision
escalations that do not block the parity sweep.
