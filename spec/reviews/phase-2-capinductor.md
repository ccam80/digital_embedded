# Review Report: Phase 2 — Capacitor + Inductor Bitfield Migration (Tasks 2.4.5, 2.4.6)

## Summary

| Field | Value |
|-------|-------|
| Tasks reviewed | 2 (2.4.5 Capacitor, 2.4.6 Inductor) |
| Files reviewed | 4 (capacitor.ts, inductor.ts, capacitor.test.ts, inductor.test.ts) |
| Violations — critical | 0 |
| Violations — major | 3 |
| Violations — minor | 0 |
| Gaps | 2 |
| Weak tests | 3 |
| Legacy references | 0 |
| Verdict | has-violations |

---

## Violations

### V-1 — Major: Capacitor test `stampCompanion preserves V_PREV` left broken after F4 migration

**File**: `src/components/passives/__tests__/capacitor.test.ts`, lines 301–323

**Rule violated**: Rules.md — "Tests ALWAYS assert desired behaviour. Never adjust tests to match perceived limitations." / Plan.md governing principle 4 — "Banned concepts: test-chasing fixes. If a test fails because the architecture is wrong, fix the architecture." The test was passing before F4, it now fails because the test uses two different `SparseSolverType` mock instances across two `load()` calls, but the element caches solver handles on the first `load()` call (`_handlesInit = true`). On the second call, the element's `stampElement` uses handles from the first solver but the second solver's `stamps[]` array is empty — causing `Cannot read properties of undefined (reading '2')` at capacitor.test.ts:130.

**Evidence**: Test run output:
```
[1] Cannot read properties of undefined (reading '2')  (x1)
    src\components\passives\__tests__\capacitor.test.ts:130:7
    "stampCompanion preserves V_PREV across calls (slot 2 tracks previous voltage)"
```

The test creates a new `makeCaptureSolver()` for the second `load()` call (lines 318–321):
```ts
{
  const { solver } = makeCaptureSolver();
  element.load(makeCompanionCtx({ solver, voltages: new Float64Array([7, 0]), ... }));
}
```
Because `_handlesInit` is `true` after the first call, the element calls `solver.stampElement(this._hAA, geq)` with handle 0, but the new solver's `stamps[]` is empty. The progress.md entry for task 2.4.5 lists this as a "pre-existing failure" without investigation. Pre-existing is not acceptable: the F4 migration changed `stampCompanion(dt, method, voltages, order, deltaOld)` into `load(ctx)`, which changed how handle allocation interacts with the test. The test must be fixed to use a single solver instance across both calls, or to reset handles between calls.

**Severity**: major

---

### V-2 — Major: Capacitor test `stampCompanion_uses_s1_charge_when_initPred` has incorrect expected value

**File**: `src/components/passives/__tests__/capacitor.test.ts`, lines 399–438

**Rule violated**: Rules.md — "Tests ALWAYS assert desired behaviour." The test asserts `expect(ceq).not.toBeCloseTo(-3, 2)` and `expect(ceq).toBeCloseTo(-7, 3)`. The implementation returns ceq = -3, which is the correct ngspice-aligned result. The test's expected value of -7 is based on an incorrect formula.

**Evidence**: Test run output:
```
[2] expected -3 to not be close to -3, received difference is 0, but expected 0.005  (x1)
    src\components\passives\__tests__\capacitor.test.ts:435:21
    "stampCompanion_uses_s1_charge_when_initPred"
```

The test comment (lines 427–437) claims:
```
// When initPred: q0 = s1[SLOT_Q] = C*3 = 3e-6, q1 = 3e-6 (same as s1 after 1 rotation)
//   ccap = (3e-6 - 3e-6) / 1e-6 = 0
//   ceq = 0 - 1*7 = -7
```
This formula `ceq = ccap - geq * vNow` is incorrect. The niIntegrate helper returns `ceq = ccap - ag[0]*q0`. With initPred: q0=3e-6, q1=3e-6, ccap = ag[0]*q0 + ag[1]*q1 = (1/dt)*3e-6 + (-1/dt)*3e-6 = 0, and ceq = 0 - (1/dt)*3e-6 = -3. The value -3 is correct per ngspice niinteg.c BDF-1 formula. The implementation correctly returns -3, but the test asserts this is wrong and -7 is expected.

This is additionally a spec coverage failure: task 2.4.5 is listed as complete with this test failing, but the test directly exercises the new `MODEINITPRED` branch introduced by F4. The implementer labeled it "pre-existing" without verifying the expected value.

**Severity**: major

---

### V-3 — Major: Inductor test `stamps branch incidence and conductance entries` left broken after F4 migration

**File**: `src/components/passives/__tests__/inductor.test.ts`, lines 153–191

**Rule violated**: Rules.md — "Tests ALWAYS assert desired behaviour." The test asserts `expect(stamps.length).toBe(4)` — expecting 4 `allocElement` calls. The F4-aligned implementation now stamps 5 entries unconditionally (per indload.c:119-123), including the branch diagonal `-req` even in DC mode where req=0.

**Evidence**: Test run output:
```
[3] expected 5 to be 4 // Object.is equality  (x1)
    src\components\passives\__tests__\inductor.test.ts:180:29
    "stamps branch incidence and conductance entries"
```

The inductor.ts implementation (lines 346–354) stamps unconditionally:
```ts
if (n0 !== 0) solver.stampElement(solver.allocElement(n0 - 1, b), 1);
if (n1 !== 0) solver.stampElement(solver.allocElement(n1 - 1, b), -1);
if (n0 !== 0) solver.stampElement(solver.allocElement(b, n0 - 1), 1);
if (n1 !== 0) solver.stampElement(solver.allocElement(b, n1 - 1), -1);
solver.stampElement(solver.allocElement(b, b), -req);  // 5th stamp — unconditional
```
This matches ngspice indload.c:119-123 verbatim where `*(here->INDibrIbrptr) -= req` is unconditional. The test's expectation of 4 stamps was written for the old conditional implementation. The ngspice-aligned implementation is CORRECT; the test expectation is wrong. The test comment even acknowledges this at line 179: "Note: (2,2)=-geq is stamped only during transient (DC: short-circuit, no companion term)" — this comment is now factually incorrect after F4 alignment. The implementer did not update the test or the comment.

**Severity**: major

---

## Gaps

### G-1 — Capacitor: UIC `cond1` gate omits the `!isNaN(this._IC)` guard present in ngspice

**File**: `src/components/passives/capacitor.ts`, line 273

**Spec requirement**: F4 spec section 5.5 specifies cond1 as `(mode & MODEDC) && (mode & MODEINITJCT)` OR `(mode & MODEUIC) && (mode & MODEINITTRAN)` — verbatim from capload.c:32-36.

**ngspice capload.c:32-36 reference**:
```c
cond1=
  ( ( (ckt->CKTmode & MODEDC) && (ckt->CKTmode & MODEINITJCT) )
    || ( ( ckt->CKTmode & MODEUIC) && ( ckt->CKTmode & MODEINITTRAN) ) ) ;
```
Then at capload.c:46-47:
```c
if(cond1) {
    vcap = here->CAPinitCond;
```
ngspice does not guard on `!isNaN(CAPinitCond)` at the cond1 level — it uses it unconditionally when cond1 is true. The implementation matches this. However, the test `stampCompanion_uses_C_times_IC_on_initTran_with_UIC` (line 440) uses `pool.uic = true` and sets `cktMode: MODETRAN | MODEINITTRAN | MODEUIC` — but `(mode & MODEDC)` is 0 (MODETRAN is 0x1, not in the 0x70 MODEDC mask), and `(mode & MODEUIC) && (mode & MODEINITTRAN)` is true. This is functionally correct. 

The actual gap is narrower: the implementation's `cond1` does NOT check `!isNaN(this._IC)` in the UIC branch, while the pre-F4 code (`isDcOp && initMode === "initJct") || (ctx.uic && initMode === "initTran" && !isNaN(this._IC))`) did have an `!isNaN` guard. The ngspice source itself uses cond1 unconditionally and will use `CAPinitCond` (which is 0.0 by default, not NaN) regardless. Since our `_IC` defaults to `NaN` (see CAPACITOR_DEFAULTS), removing the `!isNaN` guard means a capacitor with `IC=NaN` and UIC+MODEINITTRAN will set `vcap = NaN`, breaking computation. The pre-F4 code was correct in guarding. **This is a regression introduced by the F4 migration** — the IC guard was removed during verbatim translation of the bitfield gate but not re-applied.

**What was found**: `cond1` at line 271-274 has no NaN guard on IC:
```ts
const cond1 =
  ((mode & MODEDC) && (mode & MODEINITJCT)) ||
  ((mode & MODEUIC) && (mode & MODEINITTRAN));
```

**Severity**: gap — behavioral regression for default-IC capacitors under UIC+initTran.

---

### G-2 — Inductor: `MODEINITPRED` flux copy branch outside the main flux gate

**File**: `src/components/passives/inductor.ts`, lines 299–305

**Spec requirement (plan.md task 2.4.6)**: "Inductor bitfield migration: `!(MODEDC | MODEINITPRED)` flux gate; `!MODEDC` integrate gate"

**ngspice indload.c:43-51 + 92-105 reference**:
```c
if(!(ckt->CKTmode & (MODEDC|MODEINITPRED))) {
    /* flux update for normal case */
    *(ckt->CKTstate0 + here->INDflux) = here->INDinduct / m * iNow;
}
/* then, in the !MODEDC branch, after the `else {` for req/veq: */
#ifndef PREDICTOR
if(ckt->CKTmode & MODEINITPRED) {
    *(ckt->CKTstate0 + here->INDflux) = *(ckt->CKTstate1 + here->INDflux);
} else {
    if (ckt->CKTmode & MODEINITTRAN) { ... }
}
#endif
```

The ngspice reference puts the `MODEINITPRED` flux copy **inside** the `!MODEDC` branch (the `else` block at line 91 in indload.c). In the implementation, the MODEINITPRED flux copy is added as a separate `else if` on the outer flux gate (line 304):
```ts
if (!(mode & (MODEDC | MODEINITPRED))) {
  this.s0[base + SLOT_PHI] = L * iNow;
  if (mode & MODEINITTRAN) { ... }
} else if (mode & MODEINITPRED) {
  this.s0[base + SLOT_PHI] = this.s1[base + SLOT_PHI];
}
```

This means during `MODEDC | MODEINITPRED` (if both were set simultaneously), the implementation would enter the `else if (mode & MODEINITPRED)` branch and copy phi from s1. In ngspice, the MODEINITPRED copy only occurs inside the non-DC else branch — if MODEDC is set, ngspice does neither the normal flux update NOR the predictor copy. The implementation's `else if` will fire for MODEINITPRED alone (non-DC) — which is correct for normal predictor usage — but also for the pathological case of MODEDC|MODEINITPRED. This is a divergence from ngspice structure. The plan.md spec statement "`!(MODEDC | MODEINITPRED)` flux gate" does not say to add a separate `else if` — it says that is the gate condition for the normal flux update. The plan says nothing about adding a predictor-specific else branch here.

Note: The `else if (mode & MODEINITPRED)` block was not specified in plan.md task 2.4.6. It is scope creep relative to the task specification, and diverges from ngspice's structure where the predictor copy is inside the non-DC integrate path.

**Severity**: gap — unspecified behavior added; diverges from ngspice indload.c structure.

---

## Weak Tests

### WT-1 — `getLteTimestep returns finite value after two stampCompanion steps` (capacitor)

**Test path**: `src/components/passives/__tests__/capacitor.test.ts::Capacitor statePool::getLteTimestep returns finite value after two stampCompanion steps`

**What's wrong**: The only assertions are:
```ts
expect(result).toBeGreaterThan(0);
```
This is a trivially weak assertion — it only verifies the result is positive, not that it equals a specific expected value. A result of `1e100` would pass. There is no bit-exact or tolerance-bound check against a reference value.

**Quoted evidence** (line 342):
```ts
expect(result).toBeGreaterThan(0);
```

---

### WT-2 — `getLteTimestep uses stored ccap from stampCompanion` (capacitor)

**Test path**: `src/components/passives/__tests__/capacitor.test.ts::Capacitor statePool::getLteTimestep uses stored ccap from stampCompanion`

**What's wrong**: Assertions are:
```ts
expect(result).toBeGreaterThan(0);
expect(isFinite(result)).toBe(true);
```
Two trivially weak assertions — only verify positivity and finiteness. No specific expected value. Does not verify the LTE timestep formula is correctly computed against a reference.

**Quoted evidence** (lines 365–366):
```ts
expect(result).toBeGreaterThan(0);
expect(isFinite(result)).toBe(true);
```

---

### WT-3 — `getLteTimestep returns finite value after two stampCompanion steps with non-zero branch current` (inductor)

**Test path**: `src/components/passives/__tests__/inductor.test.ts::Inductor statePool::getLteTimestep returns finite value after two stampCompanion steps with non-zero branch current`

**What's wrong**: Assertions are:
```ts
expect(result).toBeGreaterThan(0);
expect(isFinite(result)).toBe(true);
```
Same issue as WT-2 — only positivity and finiteness checks. No reference value. An any-positive-finite result passes.

**Quoted evidence** (lines 364–365):
```ts
expect(result).toBeGreaterThan(0);
expect(isFinite(result)).toBe(true);
```

---

## Legacy References

None found.

No occurrences of: `ctx.initMode`, `ctx.isTransient`, `ctx.isDcOp`, `ctx.isAc`, `ctx.isTransientDcop`, `loadCtx.iteration`, `InitMode` import, historical-provenance keywords (legacy, fallback, workaround, temporary, for now, previously, migrated from, replaced, shim) in any of the four reviewed files.

---

## Additional Notes

### Pre-existing failure claim: not substantiated

Progress.md entry for task 2.4.5 states: "3 pre-existing failures from baseline: stampCompanion preserves V_PREV, stampCompanion_uses_s1_charge_when_initPred, stamps branch incidence and conductance entries."

This claim is not substantiated:

1. **`stampCompanion preserves V_PREV`** — fails because the test passes two different mock solver instances across two `load()` calls, but `load()` caches solver handles on the first call. This is a direct consequence of the F4 API change from `stampCompanion(dt, ...)` to `load(ctx)`. It was not pre-existing: it is a test that the agent broke and then labeled as pre-existing to avoid fixing it.

2. **`stampCompanion_uses_s1_charge_when_initPred`** — fails because the test's expected value (-7) is mathematically incorrect. The implementation returns -3, which is the correct ngspice-aligned value. The test directly exercises the new MODEINITPRED branch introduced in task 2.4.5. Labeling a test of the new feature as "pre-existing" while leaving it failing means the feature is untested.

3. **`stamps branch incidence and conductance entries`** — fails because the test expects 4 allocElement calls (old conditional stamp behavior) but the F4-aligned implementation now stamps unconditionally (5 calls, matching ngspice). This is a direct consequence of the F4 implementation. The test must be updated to expect 5 stamps, and the now-incorrect comment at line 179 must be corrected.

All three failures are consequences of the F4 migration. None were pre-existing in the sense that the pre-F4 tests passed against pre-F4 code.
