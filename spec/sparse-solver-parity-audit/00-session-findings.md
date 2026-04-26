# Sparse-solver parity session — findings, fixes, open issues

**Date:** 2026-04-26
**Branch:** main (working tree)
**Trigger:** "pivmp" Markowitz refactor (commits e0113dbb..754ac824) broke ~51 vitest tests downstream and the parity suite.

---

## 1. What this session did

### 1.1 C3 fix — reuse-pivot rejection mid-elimination (APPLIED)

**Bug:** `_numericLUReusePivots` mutated `_elVal` in place during elimination. On rejection (per-step pivot-magnitude guard), it returned `needsReorder: true` with `_elVal` half-eliminated. `factor()` then dispatched to `factorWithReorder()` which called `_numericLUMarkowitz()` from step 0 over the half-mutated matrix — Markowitz pivot search ran against garbage values.

**Root cause:** the OLD code (pre-pivmp) wrote LU into separate CSC arrays and left `_elVal` untouched on rejection, so fall-through to a fresh reorder was safe. The NEW code mutates `_elVal` directly per ngspice convention, so the safety-net was lost when CSC was deleted.

**Fix (sparse-solver.ts):**
- `FactorResult.rejectedAtStep?: number` field added.
- `_numericLUReusePivots` records `rejectedAtStep: k` on every rejection exit.
- Restored the ngspice spfactor.c:218-225 column-relative threshold guard inside the reuse loop (was deleted by pivmp; only structural-zero guard remained).
- `_numericLUMarkowitz(startStep = 0)` accepts a starting step; skips `_countMarkowitz` / `_markowitzProducts` init when resuming.
- `factor()` on reuse rejection now calls `_numericLUMarkowitz(rejectedAtStep)` directly (not `factorWithReorder`), preserving the half-eliminated state per ngspice's shared `Step` counter between the reuse and reorder loops in `spOrderAndFactor`.

**Verification:** type-check clean; new `sparse-reset-semantics.test.ts` passes; previously-failing `coordinator-capability` and `real-opamp` tests went from 4 fail → 3 fail.

### 1.2 `getCSCNonZeros()` post-factor convention rewrite (APPLIED)

**Background:** pivmp flipped the LU storage convention on `_elVal` (was port `pivot_k` at diag, L-scaled, U-unscaled; is now ngspice `1/pivot_k` at diag, L-unscaled, U-scaled). Tests reading `getCSCNonZeros()` post-factor get the LU artefact in the new convention.

**Audit outcome:** "blast radius" of 14 sites was a myth. 25 sites in 16 component test files all turned out to be **pre-factor** (`load → read` with no `factor()` between). Exactly **1 genuine post-factor site** found.

**Fix:**
- `src/solver/analog/__tests__/harness/harness-integration.test.ts:377` — switched to `enablePreFactorMatrixCapture(true)` + `getPreFactorMatrixSnapshot()` (29/29 tests in that file pass).

### 1.3 Loop direction fixes in `solve()` and `_applyDiagGmin` (APPLIED)

**Per-line audit found** that 3 loops walked forward where ngspice walks reverse:
- `solve()` RHS-in perm (line 589): `for k=0; k<n; k++` → reverse to match `spsolve.c:150 for I = Size; I > 0; I--`
- `solve()` output perm (line 650): same flip → matches `spsolve.c:187`
- `_applyDiagGmin` diag walk (line 2480): same flip → matches `spsmp.c:434`. Also flipped the entry guard from `if (gmin === 0) return` to ngspice form `if (gmin !== 0) { … }`.

**Honest note:** these 3 loops are **idempotent** (each iteration touches a different cell or is a pure copy). Flipping them strictly matches ngspice form per the bit-exact directive but does **not** change the floating-point output. The 1-ULP parity failures (Class A) are NOT caused by these.

**NOT flipped** (already match ngspice):
- `solve()` forward elimination loop (line 607): already `for k=0; k<n; k++` matching ngspice `spsolve.c:154 for I=1; I<=Size; I++`
- `solve()` backward substitution loop (line 634): already reverse `for k=n-1; k>=0; k--` matching ngspice `spsolve.c:173 for I=Size; I>0; I--`

---

## 2. DIFFs identified by the 4 audit agents (lines that still violate "match ngspice exactly")

Source: `spec/sparse-solver-parity-audit/0[1-4]*.md`. Agents were instructed to use a strict MATCH/DIFF classifier; in their summaries some used softening words ("semantic equivalence", "no numerical impact") which we are explicitly NOT accepting as closing verdicts. The DIFF lines remain DIFF.

### 2.1 `solve()` and RHS / Gmin (audit 04)

| Site | DIFF |
|---|---|
| ~~`solve()` line 589 RHS-in direction~~ | **FIXED** in this session |
| ~~`solve()` line 650 output direction~~ | **FIXED** |
| ~~`_applyDiagGmin` direction + entry guard~~ | **FIXED** |
| `solve()` line 568 `if (n === 0) return;` early-exit | DIFF — ngspice has no such guard. Low risk. |
| `solve()` 0-based vs 1-based array indexing throughout | DIFF in form, not in arithmetic. Pervasive translation. |

### 2.2 Markowitz pivot search (audit 01)

| Site | DIFF |
|---|---|
| `_searchForSingleton` line 1691-1694, `_quicklySearchDiagonal` line 1791-1794 | do-while with `(p >= 0) ? value : fallback` guards in place of ngspice pre-decrement while. Bounds safety addition. |
| `_searchForSingleton` line 1696, `_quicklySearchDiagonal` line 1796 | `p + 1` index arithmetic vs ngspice `(pMarkowitzProduct - Matrix->MarkowitzProd) + 1` pointer arithmetic |
| `_searchForSingleton` line 1679-1680 | Statement split vs combined assignment-and-decrement |
| `_searchEntireMatrix` lines 1980-1981 | digiTS folds `Matrix->Error = SINGULAR` into return value (`-1` vs `pLargestElement`). Architectural simplification. |
| `_quicklySearchDiagonal` line 1723, 1735, 1749 | Ternary magnitude guards `chosen >= 0 ? abs(...) : 0` vs ngspice direct dereference |

### 2.3 Factor + elimination (audit 02)

| Site | DIFF |
|---|---|
| `factor()` dispatch order | digiTS: try reuse → fall through to resumed reorder. ngspice: `spOrderAndFactor` decides at entry. C3 fix made these terminally equivalent but the entry/exit paths differ. |
| `_numericLUMarkowitz` resumption via `startStep` parameter | DIFF in API form. ngspice uses shared local `Step` counter inside `spOrderAndFactor`. C3 fix introduced this. |
| 0-based vs 1-based indexing throughout | Pervasive. |
| Doubly-linked element prev pointers (`_elPrevInRow`/`_elPrevInCol`) | digiTS-only. ngspice uses singly-linked `NextInRow`/`NextInCol` only. |
| `_diag[col] = fe` for diagonal fill-ins inside `_createFillin` | digiTS-only safety check. Comment cites "without this, solve() reads `elVal[-1] = undefined → NaN`". ngspice doesn't need it because its array semantics differ. |
| `_q[]` and `_pinv[]` permutation arrays for solve phase | digiTS-only. ngspice handles permutation via `IntToExtRowMap` directly. |

### 2.4 Build / clear / preorder (audit 03)

| Site | DIFF |
|---|---|
| Handle table `_handleTable` for O(1) stamp lookup | digiTS-only optimization. ngspice searches column chains per stamp. |
| Free-list pool management (`_elFreeHead`) | digiTS-only. ngspice allocates fixed blocks. |
| Markowitz pre-computation in `finalize()` | digiTS pre-computes; ngspice computes on-demand during pivot search. |
| `_resetForAssembly` zeros entire pool `[0, _elCount)` | digiTS strategy. ngspice `spClear` walks chains. Both preserve structure. |
| Doubly-linked maintenance | (same as 2.3) |
| Explicit RHS zeroing in `_resetForAssembly` | digiTS-only. |

---

## 3. Open issues

### 3.1 1-ULP parity failures (Class A) — root cause UNKNOWN
Tests: `rc-transient`, `rlc-oscillator`, likely `diode-resistor`.
Symptom: `expect(absDelta).toBe(+0)` fails with `absDelta ∈ {1.03e-25, 2.17e-19, ...}`.
- Loop-direction fixes applied in this session do NOT eliminate these — those loops are idempotent.
- Forward-elimination and backward-sub already match ngspice direction.
- Parity helper at `src/solver/analog/__tests__/ngspice-parity/parity-helpers.ts:40` enforces strict zero — this gate is the contract per project rules and will not be loosened.
- **Next step:** instrument an rc-transient comparison run to find the first iteration where any matrix element or RHS first diverges from ngspice. The divergence will name the responsible stamp/integration step. Do this before any further "fixes".

### 3.2 Macroscopic parity failures (Class B) — bugs outside `sparse-solver.ts`
Tests:
- `opamp-inverting`: `step=0 iter=0 rhsOld[3]: ours=0.0001 ngspice=1` (4-decade gap, source-stepping disagreement).
- `mosfet-inverter`: `step=0 iter=0 state0[M1][VBD]: ours=-1 ngspice=0` (state initialization disagreement).

Audits 01–04 found no DIFFs in `sparse-solver.ts` that could account for these magnitudes. They live in:
- `newton-raphson.ts` (NR loop / source-stepping ladder) vs ngspice `niiter.c`
- Device load functions (`mos1load.c`, `dioload.c`, etc.) vs ours
- DC-OP ladder (`dc-operating-point.ts`) vs ngspice `cktop.c::dynamicgmin`

**Next step:** apply the same line-by-line strict audit methodology to `newton-raphson.ts` and the device load functions for the failing devices.

### 3.3 `diode-bridge` parity test "hang" — NOT a solver bug
The 238-second worker timeout in the parity suite turned out to be in the comparison harness, not the solver:
- Standalone diode-bridge probe (`scripts/diag-diode-bridge-hang.ts`): DCOP completes in 3ms, full 33.3ms transient (3347 steps) completes in 31ms.
- The hang must be inside `ComparisonSession` — likely the ngspice DLL invocation, per-iteration capture, or `harness/comparison-session.ts` step bookkeeping.
- **Next step:** add a per-step wall-clock guard inside `ComparisonSession.runTransient` that logs which side (ours / ngspice) is responsible for the time, and whether capture serialization is the cost.

### 3.4 Ngspice DIFF backlog (lines that still violate strict-match)

These are not caused by anything done this session — they pre-date pivmp — but are violations per the "match ngspice always" directive:
- 0-based vs 1-based indexing pervasive throughout (translation only, not arithmetic, but mechanical replacement is in scope).
- Doubly-linked element pool (digiTS keeps `_elPrevInRow`/`_elPrevInCol`, ngspice does not). Consider reverting to singly-linked.
- `_handleTable` O(1) stamp lookup. ngspice does column-chain search. Decision: keep as digiTS optimization OR remove for strict parity. Per directive, remove.
- `_q[]`, `_pinv[]` arrays. ngspice does this differently (via `IntToExtRowMap`).
- Markowitz pre-compute timing in `finalize()`. ngspice computes inside `spOrderAndFactor`.

### 3.5 Pre-existing failures unrelated to C3 or pivmp
- `ckt-context.test.ts loadCtx_fields_populated` — `lc.voltages = undefined`. LoadContext fixture missing field.
- `dcop-init-jct.test.ts` × 3 — same root cause (LoadContext fixture missing `voltages` array).
- `sparse-solver.test.ts` × 7 white-box tests assert `markowitzRow.length === 3` (broken by pivmp's `n+2` sentinel sizing) and `_elCol_preserved_after_preorder_swap` (broken by pivmp's `_elCol[e] = slot` invariant).

### 3.6 Agents softening their classifier outputs
The four audit agents (01–04) classified individual lines correctly but their summaries contained banned words: "semantic equivalence maintained", "no numerical impact", "architectural divergence". These are exactly the closing verdicts the project rules forbid. Per CLAUDE.md, items where these phrases would be used must instead be:
- Logged as DIFF (not "equivalent")
- Escalated for explicit user decision (not "intentional")
- Either fixed to match ngspice or added to `spec/architectural-alignment.md` by the user (agents do not add)

When dispatching future audit agents, the prompt should reject summaries that use these words.

---

## 4. Files changed in this session

```
src/solver/analog/sparse-solver.ts       — C3 fix (4 edits) + loop direction fix (3 edits)
src/solver/analog/__tests__/harness/harness-integration.test.ts  — 1 site rewritten
scripts/diag-diode-bridge-hang.ts        — new diagnostic probe
spec/sparse-solver-parity-audit/         — 5 audit reports (00 = this file, 01-04 = per-area)
```

## 5. Files NOT changed despite being DIFFs

Everything in section 2 that is not in section 1.3 or 1.1. The decision to convert these to MATCH is the user's, per project rules.
