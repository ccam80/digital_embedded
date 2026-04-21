# Review Report: Phase 2 — BJT Device Group (Tasks 2.4.2 + 2.4.9b)

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 2 (2.4.2, 2.4.9b) |
| Files reviewed | 2 (`src/components/semiconductors/bjt.ts`, `src/components/semiconductors/__tests__/bjt.test.ts`) |
| Violations — critical | 4 |
| Violations — major | 2 |
| Violations — minor | 1 |
| Gaps | 3 |
| Weak tests | 5 |
| Legacy references | 0 |

**Verdict: has-violations**

---

## Violations

### V1 — CRITICAL: Small-signal store-back stores `CTOT` (cap value) into `CAP_GEQ` slots instead of `capbe`/`capbc`/`capsub` per bjtload.c:676-680

**File:** `src/components/semiconductors/bjt.ts`
**Lines:** 1875–1881

**Rule violated:** SPICE-Correct Implementations Only (CLAUDE.md); spec F4 §5.2 bjtload.c:674-689 store-back requirement.

**Evidence:**
```ts
if ((mode & MODEINITSMSIG) &&
    !((mode & MODETRANOP) && (mode & MODEUIC))) {
  // bjtload.c:676-680: store linearization caps into CKTstate0.
  s0[base + L1_SLOT_CAP_GEQ_BE] = s0[base + L1_SLOT_CTOT_BE];
  s0[base + L1_SLOT_CAP_GEQ_BC_INT] = s0[base + L1_SLOT_CTOT_BC];
  s0[base + L1_SLOT_CAP_GEQ_CS] = s0[base + L1_SLOT_CTOT_CS];
}
```

**What the spec requires:** The spec (F4 §5.2, citing bjtload.c:676-680) states the store-back must write `capbe`, `capbc`, `capsub` — the *diffusion* capacitance values computed from the transit-time model (i.e., `CtotalBE`, `CtotalBC`, `CtotalCS` as computed right before this block). The slots to be written are `L1_SLOT_CAP_GEQ_BE`, `L1_SLOT_CAP_GEQ_BC_INT`, `L1_SLOT_CAP_GEQ_CS`. In ngspice, the small-signal store-back writes the *raw* junction capacitances into the state0 slots so they persist for the AC linearization step. Here the implementation writes `CTOT` (total capacitance) back into `CAP_GEQ` slots — however `CAP_GEQ` at this point already holds the NIintegrate-computed `geq = ag[0] * C` value (written at lines 1808, 1836, 1864). Overwriting those with `CTOT` (which includes diffusion cap) is incorrect: ngspice bjtload.c:676-680 stores `capbe` (= `tf * gbe_modified`, the diffusion capacitance factor, NOT the total NIintegrate geq), not `CTOT_BE`. This is a spec mismatch — the store-back substitutes `CTOT` for the correct ngspice-derived `capbe` value and then immediately uses the overwritten `geqBE` in the lumping block (lines 1885–1906), producing wrong Norton currents during MODEINITSMSIG.

**Additionally:** The spec explicitly called for `s0[base + L1_SLOT_CAP_GEQ_BE] = capbe` where `capbe` is the transit-time-weighted diffusion cap (the `CdBE` computed at line 1730), not `CTOT_BE = CjBE + CdBE`. The implementation stores `CtotalBE` (depletion + diffusion), which is the wrong value from bjtload.c's perspective.

---

### V2 — CRITICAL: Charge-block gate `MODETRANOP && MODEUIC` sub-expression uses JavaScript `&&` on raw bitfield values without `!== 0` guards — evaluates as falsy for zero but is not a constant expression

**File:** `src/components/semiconductors/bjt.ts`
**Lines:** 1875–1876 (small-signal store-back gate) and also line 838 (L0 pnjlim gate), line 1541 (L1 pnjlim gate)

**Rule violated:** Spec requirement (review emphasis item 2): "Verify the MODETRANOP && MODEUIC expression is correctly `((mode & MODETRANOP) === MODETRANOP) && (mode & MODEUIC)`, not a syntactic constant expression."

**Evidence (small-signal store-back gate, line 1875–1876):**
```ts
if ((mode & MODEINITSMSIG) &&
    !((mode & MODETRANOP) && (mode & MODEUIC))) {
```

The sub-expression `(mode & MODETRANOP) && (mode & MODEUIC)` is NOT a constant expression — it evaluates to a truthy/falsy number depending on `mode`, which is correct. However the spec explicitly requires `((mode & MODETRANOP) === MODETRANOP) && (mode & MODEUIC)`. The current form `(mode & MODETRANOP) && (mode & MODEUIC)` relies on JavaScript truthy coercion of the bitwise-AND result (0 = false, non-zero = true). While this produces the same boolean result when `MODETRANOP = 0x20` is a single-bit constant, it is not verbatim spec compliance. The spec's `=== MODETRANOP` form explicitly checks that the bit is set exactly, following the review emphasis requirement verbatim.

**Evidence (capGate at line 1785–1788):**
```ts
const capGate =
  (mode & (MODETRAN | MODEAC)) !== 0 ||
  ((mode & MODETRANOP) !== 0 && (mode & MODEUIC) !== 0) ||
  (mode & MODEINITSMSIG) !== 0;
```
The capGate uses `!== 0` guards consistently, but the store-back gate (line 1876) and `stampCapGate` (line 2085–2087) use the truthy-coercion form without `!== 0`. This inconsistency itself is evidence that the agent did not apply the spec-required form uniformly.

**Evidence (stampCapGate, lines 2084–2087):**
```ts
const stampCapGate =
  (mode & (MODETRAN | MODEAC)) !== 0 ||
  ((mode & MODETRANOP) !== 0 && (mode & MODEUIC) !== 0) ||
  (mode & MODEINITSMSIG) !== 0;
```
The `stampCapGate` is consistent with the `capGate` form (uses `!== 0`), but the store-back gate on line 1876 (`!((mode & MODETRANOP) && (mode & MODEUIC))`) does not use `!== 0` — it is inconsistent with the other two gates in the same function.

Severity: critical per spec review emphasis ("not a syntactic constant expression").

---

### V3 — CRITICAL: No MODEINITSMSIG or MODEINITTRAN test coverage in bjt.test.ts for either L0 or L1 load paths

**File:** `src/components/semiconductors/__tests__/bjt.test.ts`

**Rule violated:** Rules §Testing — "Tests ALWAYS assert desired behaviour." Spec task 2.4.2 explicitly requires MODEINITSMSIG and MODEINITTRAN voltage-seeding branches; the test file contains zero tests exercising these branches. Neither `MODEINITSMSIG` nor `MODEINITTRAN` appear anywhere in `bjt.test.ts`.

**Evidence:**
Grep for `MODEINITSMSIG|MODEINITTRAN` in `bjt.test.ts`: **No matches found.**

The diode, JFET, and MOSFET test files all include describe blocks specifically covering `MODEINITSMSIG` seeding (confirmed from progress.md entries for tasks 2.4.1 and 2.4.4). BJT has no equivalent coverage. The spec called for tests verifying that:
- MODEINITSMSIG seeds vbe/vbc from state0 and bypasses pnjlim (L0 and L1)
- MODEINITTRAN seeds vbe/vbc from state1 and bypasses pnjlim (L0 and L1)
- MODEINITSMSIG small-signal store-back writes correct values

The implementation of these branches is untested. The pre-existing failure test `common_emitter_active_ic_ib_bit_exact_vs_ngspice` uses only `MODEDCOP | MODEINITFLOAT` — it exercises neither new branch.

---

### V4 — CRITICAL: L0 `checkConvergence` A7 fix gate includes `MODEINITSMSIG` but spec cites ngspice mos1load.c:738-742 which only uses `MODEINITFIX | MODEINITSMSIG` — implementation correct but L0 `checkConvergence` OFF gate does NOT match spec A7 exactly

**File:** `src/components/semiconductors/bjt.ts`
**Line:** 938

**Evidence (L0 checkConvergence):**
```ts
if (params.OFF && (ctx.cktMode & (MODEINITFIX | MODEINITSMSIG))) return true;
```

The spec (review emphasis item 3) states: "OFF short-circuit → `ctx.cktMode & (MODEINITFIX | MODEINITSMSIG)`". The implementation matches. This is not actually a violation — reporting for completeness. (See V2 and V3 for actual critical findings.)

**Reclassification of V4:** After re-reading, lines 938 and 2110 both implement the A7 fix correctly with `(MODEINITFIX | MODEINITSMSIG)`. V4 is not a violation. Removing from critical; promoting V5 below.

---

### V4 (revised) — CRITICAL: `ctx.noncon.value++` direct access on LoadContext in L0 and L1 load() — `noncon` is `{ value: number }` object, but the direct `.value` write bypasses the CKTCircuitContext accessor

**File:** `src/components/semiconductors/bjt.ts`
**Lines:** 852 (L0), 1559 (L1)

**Evidence:**
```ts
if (icheckLimited) ctx.noncon.value++;
```

The `LoadContext.noncon` field is typed as `{ value: number }` — a mutable reference object. Writing `ctx.noncon.value++` is the correct pattern for devices to increment the non-convergence counter through the shared object reference. This is consistent with the spec (F4 Deliverable 4 C3 fix) and is not a violation.

**Reclassification:** V4 (revised) is also not a violation. Removing from critical.

**Actual V4 — CRITICAL: L1 capGate enters NIintegrate block when `dt === 0` is prevented by `if (capGate && dt > 0)`, but MODEINITSMSIG with `dt === 0` (AC analysis context) never fires NIintegrate — small-signal store-back is therefore unreachable**

**File:** `src/components/semiconductors/bjt.ts`
**Lines:** 1785–1789

**Evidence:**
```ts
const capGate =
  (mode & (MODETRAN | MODEAC)) !== 0 ||
  ((mode & MODETRANOP) !== 0 && (mode & MODEUIC) !== 0) ||
  (mode & MODEINITSMSIG) !== 0;
if (capGate && dt > 0) {
```

During MODEINITSMSIG (AC small-signal linearization seed), `dt` is 0 (AC analysis does not have a timestep). The gate `capGate && dt > 0` therefore evaluates to `false` when `mode & MODEINITSMSIG` and `dt === 0`. This means the entire NIintegrate block — including the small-signal store-back at lines 1874–1881 — is **never executed** during MODEINITSMSIG with AC analysis timestep. The store-back is dead code in the normal AC analysis path.

Ngspice bjtload.c:561-563 gates the charge block on `MODETRAN | MODEAC | MODEINITSMSIG | (MODETRANOP && MODEUIC)` with no `dt > 0` guard — ngspice does not short-circuit on timestep for the MODEINITSMSIG path because AC analysis uses `CKTdelta` for integration coefficients (which may still be non-zero from the preceding DCOP). Our additional `dt > 0` guard silently drops the small-signal store-back.

**Severity: critical** — the MODEINITSMSIG store-back (the primary new behavior from this task) is unreachable in the normal AC analysis use case.

---

### V5 — MAJOR: L0 `load()` does not read `vbx` (external B-C voltage) or `vsub` (substrate voltage) during MODEINITSMSIG — ngspice bjtload.c:240-244 seeds vbx and vsub from rhsOld, not state0

**File:** `src/components/semiconductors/bjt.ts`
**Lines:** 808–811

**Evidence:**
```ts
if (mode & MODEINITSMSIG) {
  // bjtload.c:236-244: MODEINITSMSIG seeds vbe/vbc from CKTstate0.
  vbeRaw = s0[base + SLOT_VBE];
  vbcRaw = s0[base + SLOT_VBC];
}
```

ngspice bjtload.c:236-244 (quoted in spec F4 §5.2):
```c
if(ckt->CKTmode & MODEINITSMSIG) {
    vbe= *(ckt->CKTstate0 + here->BJTvbe);
    vbc= *(ckt->CKTstate0 + here->BJTvbc);
    vbx=model->BJTtype*(
        *(ckt->CKTrhsOld+here->BJTbaseNode)-
        *(ckt->CKTrhsOld+here->BJTcolPrimeNode));
    vsub=model->BJTtype*model->BJTsubs*(
        *(ckt->CKTrhsOld+here->BJTsubstNode)-
        *(ckt->CKTrhsOld+here->BJTsubstConNode));
}
```

The L0 simple model does not have substrate or external base resistance nodes, so `vbx`/`vsub` are not relevant to L0. This is not a violation for L0.

**Actual V5 — MAJOR: L1 MODEINITSMSIG block does not seed `vbx` from rhsOld; spec bjtload.c:240-244 requires it**

**File:** `src/components/semiconductors/bjt.ts`
**Lines:** 1507–1510

**Evidence:**
```ts
if (mode & MODEINITSMSIG) {
  // bjtload.c:236-244: MODEINITSMSIG seeds vbe/vbc from CKTstate0.
  vbeRaw = s0[base + L1_SLOT_VBE];
  vbcRaw = s0[base + L1_SLOT_VBC];
}
```

The spec requires `vbx` to be seeded from `rhsOld` during MODEINITSMSIG (bjtload.c:240-242). The L1 model has an external base node (`nodeB_ext`) distinct from the internal base node (`nodeB_int`) when `RB > 0`. `vbx` is used in the external BC cap stamp. The implementation seeds `vbeRaw`/`vbcRaw` only, and does not compute `vbx` for the MODEINITSMSIG path from the solution vector. When `RB > 0`, the external cap stamps will use stale or zero `vbx` values.

**Severity: major** — only affects circuits with `RB > 0` during AC analysis. The default `RB = 0` case is unaffected.

---

### V6 — MAJOR: `checkConvergence_does_not_always_return_true_when_OFF_in_transient_mode` test uses trivially weak assertion `expect(typeof result).toBe("boolean")`

**File:** `src/components/semiconductors/__tests__/bjt.test.ts`
**Lines:** 1258–1278

**Rule violated:** Rules §Testing — "Test the specific: exact values, exact types, exact error messages where applicable." An assertion that only checks `typeof result` is a bare-minimum existence check — any return value from `checkConvergence` passes it. The test comment says "result may be true or false" which signals the agent explicitly chose not to pin the expected value.

**Evidence:**
```ts
// checkConvergence should not blindly return true in transient mode
const result = element.checkConvergence!(ctx);
// Converged (all zeros → no icheck limitation) — result may be true or false
// but the key is it doesn't throw
expect(typeof result).toBe("boolean");
```

The test name states "does_not_always_return_true_when_OFF_in_transient_mode" but the assertion does not verify that the result is `false` (or even that it differs from the always-true case). The correct assertion for all-zero voltages with no pnjlim activity would be `expect(result).toBe(true)` — the tolerance check at zero voltages should converge. The test is testing that `checkConvergence` doesn't throw, not that it produces the correct convergence decision.

**Severity: major** — the test name makes a behavioral claim that the assertion does not enforce.

---

### V7 — MINOR: Comment at line 1516 uses the word "fallback" in a way that could be confused with a dead-code marker

**File:** `src/components/semiconductors/bjt.ts`
**Line:** 1516

**Evidence:**
```ts
} else if (mode & MODEINITJCT) {
  // bjtload.c:258-276: MODEINITJCT with OFF / UIC / fallback.
```

The word "fallback" here refers to the third branch in ngspice's `MODEINITJCT` handling (the `else` case that seeds `vbe = tVcrit, vbc = 0`), not to a backwards-compatibility shim. However rules.md §Code Hygiene explicitly lists "fallback" as a banned word in comments. The context is a citation of ngspice source behavior, but the rule makes no exception for citations.

**Severity: minor** — the code itself is correct; only the comment word is banned.

---

## Gaps

### G1 — No MODEINITSMSIG test for L0 BJT simple model

**Spec requirement:** Task 2.4.2 adds MODEINITSMSIG and MODEINITTRAN seeding branches to L0 `load()`. Per spec and the pattern established by diode (task 2.4.1) and JFET (task 2.4.4), both of which added MODEINITSMSIG test describe blocks, L0 BJT requires equivalent coverage.

**What was found:** Zero tests in `bjt.test.ts` set `cktMode` to include `MODEINITSMSIG` or call `load()` under that mode for the simple BJT element. The two new branches (lines 808–815) are entirely unexercised.

**File:** `src/components/semiconductors/__tests__/bjt.test.ts`

---

### G2 — No MODEINITSMSIG or MODEINITTRAN test for L1 BJT SPICE model

**Spec requirement:** Task 2.4.2 adds MODEINITSMSIG and MODEINITTRAN seeding branches to L1 `load()`, plus the small-signal store-back block. These are the primary new behaviors of the task. No test verifies that seeding occurs from state0 (MODEINITSMSIG) or state1 (MODEINITTRAN), that pnjlim is bypassed, or that the store-back writes the correct values.

**What was found:** Zero tests in `bjt.test.ts` exercise L1 MODEINITSMSIG or MODEINITTRAN paths.

**File:** `src/components/semiconductors/__tests__/bjt.test.ts`

---

### G3 — No test for A7 checkConvergence fix under MODEINITSMSIG (returns true when OFF)

**Spec requirement:** Review emphasis item 3 requires that `checkConvergence` returns `true` when `params.OFF && (ctx.cktMode & (MODEINITFIX | MODEINITSMSIG))`. The existing test `checkConvergence_returns_true_during_initFix_when_OFF` covers `MODEINITFIX`. The `MODEINITSMSIG` branch of the gate is untested.

**What was found:** No test in `bjt.test.ts` sets `params.OFF = 1` and calls `checkConvergence` with `cktMode` containing `MODEINITSMSIG`. The A7 fix for `MODEINITSMSIG` in `checkConvergence` is implemented at lines 938 and 2110 but has no test coverage.

**File:** `src/components/semiconductors/__tests__/bjt.test.ts`

---

## Weak Tests

### WT1 — `checkConvergence_does_not_always_return_true_when_OFF_in_transient_mode`: trivially true assertion

**Test path:** `src/components/semiconductors/__tests__/bjt.test.ts::BJT OFF parameter::checkConvergence_does_not_always_return_true_when_OFF_in_transient_mode`

**What is wrong:** The assertion `expect(typeof result).toBe("boolean")` verifies only that the function returns a boolean — it does not check whether the result is correct. The test name claims to verify behavioral correctness ("does not always return true") but the assertion cannot detect if `checkConvergence` incorrectly returns `true` or `false`.

**Evidence:**
```ts
expect(typeof result).toBe("boolean");
```

---

### WT2 — `active_region_stamp`: `entries.length` and `nonzeroRhsRows` checks are structural, not behavioral

**Test path:** `src/components/semiconductors/__tests__/bjt.test.ts::NPN::active_region_stamp`

**What is wrong:** The assertions `expect(entries.length).toBe(9)` and `expect(nonzeroRhsRows).toBe(3)` verify the matrix structure (number of nonzero entries and stamped RHS rows) but do not verify that the actual conductance values or Norton current values are correct. A buggy implementation that stamps wrong conductances but in the right positions would pass these checks.

**Evidence:**
```ts
expect(entries.length).toBe(9);
// ...
expect(nonzeroRhsRows).toBe(3);
```

The `gm`, `go`, `gpi`, `gmu` values are computed and asserted on `exp` (the analytical helper), not on the actual element's stamped values retrieved from the solver. The test never checks that the solver matrix contains the correct numerical conductances.

---

### WT3 — `load_stores_limited_vbe_vbc_in_pool` (L0 and L1): range checks instead of exact values

**Test path:** `src/components/semiconductors/__tests__/bjt.test.ts::StatePool — BJT simple write-back elimination::load_stores_limited_vbe_vbc_in_pool`
**Test path:** `src/components/semiconductors/__tests__/bjt.test.ts::StatePool — BJT SPICE L1 write-back elimination::load_stores_limited_vbe_vbc_in_pool`

**What is wrong:** Both tests use `toBeGreaterThan(0.5)` and `toBeLessThanOrEqual(0.7)` range checks for the stored VBE value rather than asserting the exact converged pnjlim-limited value. After 50 load iterations the value converges deterministically — the exact value can be pinned.

**Evidence:**
```ts
expect(vbeInPool).toBeGreaterThan(0.5);
expect(vbeInPool).toBeLessThanOrEqual(0.7);
```

---

### WT4 — `voltage_limiting_both_junctions`: range check for `vbeLimited` instead of exact pnjlim result

**Test path:** `src/components/semiconductors/__tests__/bjt.test.ts::NPN::voltage_limiting_both_junctions`

**What is wrong:** `expect(vbeLimited).toBeLessThan(5.0)` and `expect(vbeLimited - 0.3).toBeLessThan(4.5)` are loose upper-bound checks. The pnjlim algorithm produces a deterministic output from a known input (5.0V input, 0.3V previous value, tVcrit). The exact result can and should be asserted.

**Evidence:**
```ts
expect(vbeLimited).toBeLessThan(5.0);
expect(vbeLimited - 0.3).toBeLessThan(4.5);
```

---

### WT5 — `npn_cutoff_with_zero_base_drive`: loose range check for `vCollector`

**Test path:** `src/components/semiconductors/__tests__/bjt.test.ts::Integration::npn_cutoff_with_zero_base_drive`

**What is wrong:** `expect(vCollector).toBeGreaterThan(4.9)` and `expect(vCollector).toBeLessThan(5.0)` are range checks. A SPICE-correct simulation with the given parameters produces a deterministic value for `vCollector`. The test should use `toBeCloseTo` with the ngspice reference value, or `expectSpiceRef` which the test file already defines.

**Evidence:**
```ts
expect(vCollector).toBeGreaterThan(4.9);
expect(vCollector).toBeLessThan(5.0);
```

---

## Legacy References

None found.

No `ctx.initMode`, `ctx.isTransient`, `ctx.isDcOp`, `ctx.isAc`, or `loadCtx.iteration` references were found in either `bjt.ts` or `bjt.test.ts`. No `Math.exp(Math.min(..., 700))` patterns found. No banned historical-provenance comment words found (the single "fallback" occurrence is cited in V7 as a minor comment violation, not a dead-code marker).

---

## Pre-existing Failure Status

The test `common_emitter_active_ic_ib_bit_exact_vs_ngspice` uses `expect(pool.state0[6]).toBe(NGSPICE_IC)` and `expect(pool.state0[7]).toBe(NGSPICE_IB)` — strict `toBe` (identity equality) assertions, as expected for the carried-forward 1-ulp baseline failure. The test has not been weakened: the assertion is strict bit-exact comparison, consistent with its status as a known pre-existing 1-ulp failure. The progress.md entry for the pre-existing failure is correctly carried forward.
