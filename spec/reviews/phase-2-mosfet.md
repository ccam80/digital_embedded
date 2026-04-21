# Review Report: Phase 2 — MOSFET + shared fet-base MODEINITSMSIG + bitfield migration

**Tasks reviewed:** 2.4.3 (MOSFET MODEINITSMSIG + cktMode state rename), 2.4.8 (shared solver helpers, including fet-base MODEINITSMSIG store-back), 2.4.9c (MOSFET checkConvergence A7 fix)

**Spec files:** `spec/ngspice-alignment-F4-cktload-devices.md`, `spec/ngspice-alignment-F3-dcop-transient.md`

**Files reviewed:**
- `src/components/semiconductors/mosfet.ts`
- `src/solver/analog/fet-base.ts`
- `src/components/semiconductors/__tests__/mosfet.test.ts`
- `src/solver/analog/behavioral-remaining.ts`
- `src/solver/analog/bridge-adapter.ts`
- `src/solver/analog/digital-pin-model.ts`
- `src/solver/analog/ckt-mode.ts`

---

## Summary

| Category | Count |
|----------|-------|
| Violations — critical | 2 |
| Violations — major | 2 |
| Violations — minor | 1 |
| Gaps | 1 |
| Weak tests | 0 |
| Legacy references | 0 |

**Verdict: has-violations**

---

## Violations

---

### VIOLATION-1 (critical): Known test regression left unresolved — `cgs_cgd_transient_matches_ngspice_mos1`

**File:** `src/components/semiconductors/__tests__/mosfet.test.ts` (line 1046)

**Rule violated:** `spec/.context/rules.md` — "Never mark work as deferred, TODO, or 'not implemented.'" and CLAUDE.md — "A task is complete when it is executed exactly as specified."

**Evidence:**

`spec/progress.md` (task `fix-2.4.mosfet-duplicate-const-mode`) explicitly records:

> "Tests: 48/49 passing. `cgs_cgd_transient_matches_ngspice_mos1` fails with `expected +0 to be -3.549928774784246e-12` — caused by the wave 2.4.3 `useDoubleCap` logic change (not by this rename)."

The test at `mosfet.test.ts:1046` is not skipped, not xfailed, and not marked as expected-failure. It asserts correct ngspice behavior:

```ts
// Verify ceq = ccap - ag[0]*q0 (bit-exact)
const ceq_expected = ccap_expected - ag[0] * q0_db;
expect(stored_ceq).toBe(ceq_expected);   // line 1148 — FAILS: expected +0 to be -3.549928774784246e-12
```

The test was 49/49 passing before wave 2.4.3. The regression was introduced by the implementation and not fixed. The implementation stores `+0` in `SLOT_CAP_IEQ_DB` when ngspice would store `-3.549928774784246e-12`. This is a real numerical discrepancy — the DB junction cap companion current (`ceq`) is wrong — not a test that needs updating.

The failure admitted in progress.md was neither fixed nor escalated; it was silently carried forward. This is a deferred regression, which is banned.

---

### VIOLATION-2 (critical): Redundant double-write of `_ctxCktMode` — dead-code marker confirmed by progress.md

**File:** `src/solver/analog/fet-base.ts` (line 260) and `src/components/semiconductors/mosfet.ts` (line 1196)

**Rule violated:** `spec/.context/rules.md` — "All replaced or edited code is removed entirely. Scorched earth." and the historical-provenance / dead-code rule.

**Evidence:**

`fet-base.ts:258-261`:
```ts
load(ctx: LoadContext): void {
  // 1-6: update internal linearization from current NR iterate
  this._ctxCktMode = ctx.cktMode;   // <-- write #1
  this._updateOp(ctx);
```

`mosfet.ts:1195-1196`:
```ts
protected override _updateOp(ctx: LoadContext): void {
  this._ctxCktMode = ctx.cktMode;   // <-- write #2, overwrites write #1 identically
```

`spec/progress.md` (task `2.4.8`) explicitly states:

> "removed duplicate private `_ctxCktMode` field (now inherited as protected from AbstractFetElement); **retained mosfet._updateOp assignment which is redundant but harmless**"

The word "redundant but harmless" is a dead-code marker. The agent knowingly left a redundant assignment and documented it as such. Per the rules: the comment/acknowledgement that code is redundant is proof the agent knowingly broke the rule, not a mitigating factor.

The field is written in `load()` (base class) unconditionally before `_updateOp()` is called, then written again identically in `_updateOp()`. The second write is dead — it never produces a different value. It must be deleted, along with the comment at `fet-base.ts:194-196` if it was written to justify this duplication.

---

### VIOLATION-3 (major): Unresolved test regression admitted without escalation or fix

**File:** `spec/progress.md` (task `fix-2.4.mosfet-duplicate-const-mode`)

**Rule violated:** CLAUDE.md Escalation Protocol — "If you cannot fully implement what was specified: STOP immediately. Do not attempt a partial solution. Report: what you attempted, what specifically blocked you."

**Evidence:** The agent detected a regression, wrote a comment in progress.md attributing it to a prior wave, and continued anyway (recording 48/49 passing as the final state). The correct action was to stop, diagnose, and fix the regression or escalate. The agent neither fixed the root cause nor escalated.

The admission reads: "caused by the wave 2.4.3 `useDoubleCap` logic change (not by this rename)" — this is an attempt to attribute blame elsewhere to avoid fixing, which is exactly the pattern the Escalation Protocol exists to prevent.

---

### VIOLATION-4 (major): MOSFET capGate uses JFET-spec expression — not the MOS1-spec expression

**File:** `src/solver/analog/fet-base.ts` (lines 268-271)

**Rule violated:** CLAUDE.md — "SPICE-Correct Implementations Only: When implementing or fixing any SPICE-derived algorithm, match the corresponding ngspice source function exactly."

**Evidence:**

The fet-base `load()` uses the capGate from `jfetload.c:425-426`:
```ts
// jfetload.c:425-426: MODETRAN | MODEAC | MODEINITSMSIG or (MODETRANOP && MODEUIC).
const capGate =
  (ctx.cktMode & (MODETRAN | MODEAC | MODEINITSMSIG)) !== 0 ||
  ((ctx.cktMode & MODETRANOP) !== 0 && (ctx.cktMode & MODEUIC) !== 0);
```

However, the MOSFET inherits this capGate. ngspice `mos1load.c:762` defines the MOSFET Meyer-cap gate as:
```c
if ( ckt->CKTmode & (MODETRAN | MODETRANOP | MODEINITSMSIG) ) {
```

This is a different expression:
- ngspice MOS1: `MODETRAN | MODETRANOP | MODEINITSMSIG` (MODETRANOP is unconditional, MODEAC is absent)
- Implementation inherited by MOSFET: `(MODETRAN | MODEAC | MODEINITSMSIG) || (MODETRANOP && MODEUIC)` (MODEAC present, MODETRANOP only when MODEUIC set)

The MOS1 cap block fires during MODETRANOP regardless of MODEUIC. The implementation (inherited from JFET) only fires during MODETRANOP when MODEUIC is also set. This means the gate junction caps (DB, SB) and Meyer GB cap are NOT computed during the transient-boot DCOP without UIC — which is the normal case. This is a spec-correctness divergence from mos1load.c.

The reviewer assignment confirms this check (point 6): "Verify the `MODETRANOP && MODEUIC` expression is NOT `(MODETRANOP & MODEUIC)` as a constant." The implementation avoids the constant-expression bug, but uses the wrong gate condition for MOSFET semantics.

---

### VIOLATION-5 (minor): Comment in fet-base.ts describes what code "used" to do

**File:** `src/solver/analog/fet-base.ts` (lines 194-196)

**Rule violated:** `spec/.context/rules.md` — "Comments exist ONLY to explain complicated code to future developers. They never describe what was changed, what was removed, or historical behaviour."

**Evidence:**
```ts
// Cached cktMode from the most recent load() ctx — used by _stampCompanion
// which is called from load() without a ctx parameter.
protected _ctxCktMode: number = 0;
```

This comment describes _why_ the field exists (caching for cross-method access). This specific comment is acceptable on its own, but in context of the redundant double-write (VIOLATION-2), the comment serves partly to justify the field's existence despite the redundant assignment in the subclass override. The comment does not describe historical behavior directly, so this is minor.

---

## Gaps

---

### GAP-1: Spec requires 5 doubling guards replaced; implementation has 4 in mosfet.ts + 1 effectively in fet-base

**Spec requirement (review assignment, point 3):** "All 5 `_ctxInitMode === "initTran"` doubling guards (per spec) replaced with `(this._ctxCktMode & (MODETRANOP | MODEINITSMSIG)) !== 0` per mos1load.c:789-795."

**What was found:**

In `mosfet.ts`, there are exactly 4 occurrences of `(this._ctxCktMode & (MODETRANOP | MODEINITSMSIG)) !== 0`:
- Line 1185: `useDoubleCap` (Meyer GS/GD in `computeCapacitances`)
- Line 1741: `useDoubleGb` (Meyer GB in `_stampCompanion`)
- Line 1810: `useDoubleCapU` (Meyer GB in `_updateChargeFlux`)
- Line 1895: `useDoubleCapU2` (Meyer GB recalc in `_updateChargeFlux`)

The 5th doubling guard is in `fet-base.ts:_stampCompanion` via the `useDoubleCap` variable that replaced `isFirstCall`. The progress.md spec says 5 guards were in mosfet.ts originally; the migration moved one to the base class. This is consistent with the spec's intent IF the base class guard is verified correct. The base class guard in `_stampCompanion` at lines 506-511 is for MODEINITSMSIG early return, not a doubling guard. The base class does not apply the MODETRANOP|MODEINITSMSIG doubling for GS/GD charges in the same form — instead it uses `isFirstCall` logic (line 605: `if (isFirstCall)` in the TRANOP branch). This means the GS/GD doubling for MODEINITSMSIG may not be correctly applied in the JFET/base-class path, but that is outside the scope of the MOSFET-specific review. For MOSFET, `computeCapacitances` handles the GS/GD doubling at line 1185. This gap is borderline — the count discrepancy (4 in mosfet.ts vs 5 claimed) is explained by the architectural split. Not a hard gap for MOSFET correctness, but the count differs from what the review assignment specifies.

**File:** `src/components/semiconductors/mosfet.ts`

---

## Weak Tests

None found. Test assertions are specific and numerical (bit-exact comparisons using `toBe`). No skips, no xfails, no loose tolerances.

---

## Legacy References

No legacy string comparisons (`ctx.initMode === "..."`, `ctx.isTransient`, `ctx.isDcOp`, `ctx.isAc`, `loadCtx.iteration`, `_ctxInitMode`) found in any of the reviewed files. All reads correctly use `ctx.cktMode & MODE*` bitfield tests.

---

## Detailed Compliance Checks (per review assignment)

| # | Check | Result |
|---|-------|--------|
| 1 | `_ctxInitMode` → `_ctxCktMode: number` rename | PASS — no `_ctxInitMode` anywhere in mosfet.ts or fet-base.ts |
| 2 | `_updateOp`/`_updateOpImpl` use `ctx.cktMode` with `MODEINITPRED`/`MODEINITJCT` bitfield tests | PASS — mosfet.ts:1196, 1203-1218 |
| 3 | All 5 doubling guards replaced with `MODETRANOP|MODEINITSMSIG` | PARTIAL — 4 in mosfet.ts, see GAP-1 |
| 4 | MODEINITTRAN zero-companion guard uses `_ctxCktMode & MODEINITTRAN` | PASS — mosfet.ts:1758 |
| 5 | checkConvergence A7: `MODEINITFIX|MODEINITSMSIG` short-circuit | PASS — mosfet.ts:1588 |
| 6 | fet-base capGate: correct `MODETRANOP && MODEUIC` expression (not constant `MODETRANOP & MODEUIC`) | PASS (not a constant) but WRONG GATE for MOSFET — see VIOLATION-4 |
| 7 | fet-base MODEINITSMSIG store-back: stores `caps.cgs→SLOT_Q_GS`, `caps.cgd→SLOT_Q_GD`, returns early | PASS — fet-base.ts:506-511 |
| 8 | No duplicate private `_ctxCktMode` in mosfet.ts | PASS — no `private _ctxCktMode` declaration in mosfet.ts |
| 9 | 2.4.8 helper migrations use bitfield reads | PASS — behavioral-remaining.ts, bridge-adapter.ts, digital-pin-model.ts all use `ctx.cktMode & MODETRAN` |
| 10 | Zero legacy references in mosfet.ts + fet-base.ts | PASS |
| 11 | Test regression `cgs_cgd_transient_matches_ngspice_mos1` | FAIL — admitted regression not fixed (see VIOLATION-1, VIOLATION-3) |
| 12 | No dead code / `retained`/`harmless` comments | FAIL — progress.md admits "redundant but harmless" assignment (see VIOLATION-2) |
| 13 | No commented-out code, no TODO/FIXME/HACK, no skip/xfail | PASS |
