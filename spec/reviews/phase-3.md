# Review Report: Phase 3 — Transient Loop (Wave 5)

**Tasks reviewed:** 3.1.1, 3.1.2, 3.2.1, 3.2.2
**Review date:** 2026-04-16
**Reviewer:** claude-orchestrator:reviewer (a5be445694a1cbd3e)

---

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 4 |
| Violations — critical | 0 |
| Violations — major | 2 |
| Violations — minor | 1 |
| Gaps | 0 |
| Weak tests | 2 |
| Legacy references | 0 |

**Verdict:** has-violations

---

## Violations

### V-1 — Major — Orphaned JSDoc block before wrong function

**File:** `src/solver/analog/integration.ts`, lines 286–296

**Rule violated:** Code Hygiene — "Comments exist ONLY to explain complicated code to future developers." A JSDoc block that belongs to one function but physically precedes another is misleading documentation that attaches to the wrong symbol in IDE tooling.

**Evidence:**
```typescript
/**
 * Centralized NIcomCof — compute integration coefficients ag[] into shared store.
 *
 * Mirrors ngspice nicomcof.c. Called once per transient retry iteration in
 * analog-engine.ts step(), BEFORE companion stamping. Elements read ag[0] etc.
 * from statePool.ag instead of deriving 1/dt locally.
 *
 * ag[0] = coefficient on Q_n (current timepoint)
 * ag[1] = coefficient on Q_{n-1}
 * ag[2] = coefficient on Q_{n-2} (BDF-2 only)
 */
/**
 * Solve the GEAR Vandermonde system for integration coefficients ag[0..order].
 * ...
 */
function solveGearVandermonde(
```

The first JSDoc (lines 286–296) is written to describe `computeNIcomCof` but is physically attached to `solveGearVandermonde` because the second JSDoc immediately follows it. TypeScript/IDE tooling associates the "Centralized NIcomCof" description with the private `solveGearVandermonde` function. The exported `computeNIcomCof` at line 399 has no JSDoc at all. This is two problems in one: a JSDoc-less public export and a misdirected JSDoc decorating the wrong (private, unexported) function. The agent wrote the description for the exported function but placed it immediately before a different function.

**Severity:** major

---

### V-2 — Major — Fragmented statePool guard blocks instead of unified block; task-reference comment in production code

**File:** `src/solver/analog/analog-engine.ts`, lines 410–422

**Rule violated:** CLAUDE.md "No Pragmatic Patches — Always implement the cleanest final architecture." The spec pseudocode unifies all statePool operations (dt assignment, computeNIcomCof call, initMode set) into a single guarded block. The implementation splits them across three separate `if (statePool)` checks, which is a pragmatic shortcut that fragments logically related operations and creates maintenance risk.

Additionally, the comment `// Centralized NIcomCof (item 5.3):` at line 413 is a task-reference comment (historical provenance referencing a spec item number), which rules.md bans.

**Evidence:**
```typescript
if (statePool) statePool.dt = dt;

// Centralized NIcomCof (item 5.3): compute ag[] into statePool.ag before
// companion stamping so elements read from the shared store.
if (statePool) {
  computeNIcomCof(dt, this._timestep.deltaOld, this._timestep.currentOrder,
    this._timestep.currentMethod, statePool.ag);
}
if (statePool) {
  if (this._firsttime) {
    statePool.initMode = "initTran";
  }
}
```

The spec pseudocode collapses all three into one block. While functionally equivalent in synchronous JS (statePool cannot become null between guards), the three-block structure with a banned task-reference comment violates both the architecture cleanliness rule and the historical-provenance comment ban.

**Severity:** major (two violations in one location: fragmented architecture + banned comment)

---

### V-3 — Minor — Test description factually wrong after 4→8 array expansion

**File:** `src/solver/analog/__tests__/state-pool.test.ts`, line 6

**Rule violated:** Rules.md testing rule — "Test the specific." The test description "allocates four Float64Array vectors of the given size" is factually incorrect for a pool that now allocates eight. This is a stale description that survived the Task 6.2.1 expansion from 4 to 8 state arrays.

**Evidence:**
```typescript
it('allocates four Float64Array vectors of the given size', () => {
  const pool = new StatePool(10);
  expect(pool.state0).toBeInstanceOf(Float64Array);
  expect(pool.state1).toBeInstanceOf(Float64Array);
  expect(pool.state2).toBeInstanceOf(Float64Array);
  expect(pool.state3).toBeInstanceOf(Float64Array);
  // state4-state7 not checked here — checked in a separate test
```

The description states "four" but the pool has eight. The body only checks state0–state3. A separate test at line 37 checks state4–state7, but the first test's description actively misrepresents the pool architecture. Future developers reading the test name will conclude the pool has four arrays.

**Severity:** minor

---

## Gaps

None found.

All four tasks (3.1.1, 3.1.2, 3.2.1, 3.2.2) have implementations that satisfy the spec requirements. Detailed cross-reference in the table at the end of this report.

---

## Weak Tests

### WT-1 — GEAR coefficients sum tolerance is too loose to verify the stated property

**Test path:** `src/solver/analog/__tests__/integration.test.ts::computeNIcomCof::GEAR coefficients sum to zero (interpolation constraint)`

**File:** `src/solver/analog/__tests__/integration.test.ts`, lines 591–601

**What's wrong:** The assertion `expect(Math.abs(sum)).toBeLessThan(1e-6 / h)` with `h = 1e-6` evaluates to a tolerance of `1.0`. The GEAR order-6 coefficients have individual magnitudes on the order of `2.45e6` (e.g. `ag[0] ≈ 49/(20h) ≈ 2.45e6`). An absolute sum error up to `0.999` would be accepted by this test — yet that would be a catastrophically wrong implementation of the interpolation constraint. The interpolation constraint (sum of coefficients = 0) should hold to floating-point precision: a correct implementation produces `|sum| < 1e-9` for these inputs. A tolerance of `1.0` makes this assertion near-trivially true and defeats the purpose of the test.

**Evidence:**
```typescript
it("GEAR coefficients sum to zero (interpolation constraint)", () => {
  const ag = new Float64Array(8);
  for (const order of [2, 3, 4, 5, 6]) {
    ag.fill(0);
    computeNIcomCof(h, [h, h, h, h, h, h], order, "gear", ag);
    let sum = 0;
    for (let k = 0; k <= order; k++) sum += ag[k];
    expect(Math.abs(sum)).toBeLessThan(1e-6 / h);  // = 1.0 — accepts sum errors up to 1.0
  }
});
```

The tolerance should be tightened to something like `1e-9` (absolute) or a relative check against the largest coefficient. As written, this test would pass for implementations with large systematic errors in the sum.

---

### WT-2 — BDF-2 degenerate test name contradicts the actual assertion

**Test path:** `src/solver/analog/__tests__/integration.test.ts::computeNIcomCof::BDF-2 degenerate (h1=0): falls back to BE coefficients`

**File:** `src/solver/analog/__tests__/integration.test.ts`, lines 505–513

**What's wrong:** The test name says "falls back to BE coefficients" (Backward Euler: `ag[0]=1/dt, ag[1]=-1/dt`), but the assertions verify equal-step BDF-2 coefficients (`ag[0]=3/(2h), ag[1]=-2/h, ag[2]=1/(2h)`). The inline comment in the test body also contradicts the name: it correctly explains the `safeH1=dt` fallback gives equal-steps BDF-2, not BE. The name says one thing, the code asserts another. This constitutes a misleading test — the wrong behavior would be named correctly by the test description if BE coefficients were accidentally produced.

**Evidence:**
```typescript
it("BDF-2 degenerate (h1=0): falls back to BE coefficients", () => {
  // deltaOld[1]=0 triggers safeH1=dt fallback, which gives equal-steps BDF-2, not BE.
  // Spec: h1 = deltaOld[1] > 0 ? deltaOld[1] : dt — so h1=dt → equal steps BDF-2.
  const ag = new Float64Array(8);
  computeNIcomCof(h, [h, 0], 2, "bdf2", ag);
  // h1=0 → safeH1=dt=h → same as equal steps
  expect(ag[0]).toBeCloseTo(3 / (2 * h), 10);  // BDF-2, not BE
  expect(ag[1]).toBeCloseTo(-2 / h, 10);
  expect(ag[2]).toBeCloseTo(1 / (2 * h), 10);
});
```

The test name "falls back to BE coefficients" is incorrect. If the implementation accidentally produced true BE coefficients (`ag[0]=1/h, ag[1]=-1/h`), this test would fail — so the assertion is not wrong, but the description is actively misleading and will cause confusion when diagnosing future failures.

---

## Legacy References

None found.

- `acceptTimestep` does not appear anywhere in `src/solver/analog/*.ts` (confirmed via grep — zero matches).
- No stale imports of removed symbols.
- No backwards-compatibility shims, re-exports, or deprecated wrappers.
- No feature flags or old/new behaviour toggles.
- Occurrences of "fallback" in reviewed files are legitimate algorithmic terms (DC-OP three-level fallback stack, GEAR degenerate-u22 fallback to BE, `FALLBACK_SPEC` in behavioral files outside scope) — not dead-code markers.

---

## Spec Cross-Reference

| Spec Requirement | File | Line | Status |
|---|---|---|---|
| 3.1.1: `rotateStateVectors()` in StatePool | state-pool.ts | 108 | Met |
| 3.1.1: Pointer ring rotation, no data copy | state-pool.ts | 108–114 | Met |
| 3.1.1: `states[0]` = recycled last slot | state-pool.ts | 109,113 | Met |
| 3.1.1: Call BEFORE for(;;) in step() | analog-engine.ts | 346 | Met |
| 3.1.1: `refreshElementRefs()` after rotate | analog-engine.ts | 347 | Met |
| 3.1.1: Remove `acceptTimestep()` | state-pool.ts | (absent) | Met |
| 3.1.1: Acceptance block only increments `tranStep` | analog-engine.ts | 594 | Met |
| 3.1.2: `ag: Float64Array` size 8 on StatePool | state-pool.ts | 50 | Met |
| 3.1.2: `analysisMode="tran"` BEFORE ag-zero | analog-engine.ts | 835 | Met |
| 3.1.2: `ag[0]=0; ag[1]=0` BEFORE `seedHistory()` | analog-engine.ts | 836–838 | Met |
| 3.1.2: Same ordering in `_transientDcop()` | analog-engine.ts | 929–932 | Met |
| 3.1.2: `reset()` zeros ag[] | state-pool.ts | 123 | Met |
| 3.2.1: `computeNIcomCof()` exported from integration.ts | integration.ts | 399 | Met |
| 3.2.1: trapezoidal order 1: ag[0]=1/dt, ag[1]=-1/dt | integration.ts | 409–411 | Met |
| 3.2.1: trapezoidal order 2: xmu=0.5 | integration.ts | 412–415 | Met |
| 3.2.1: bdf2 with degenerate u22 guard | integration.ts | 417–430 | Met |
| 3.2.1: BDF-1 fallback else branch | integration.ts | 433–436 | Met |
| 3.2.1: dt<=0 guard fills zeros | integration.ts | 406 | Met |
| 3.2.1: Called before companion stamp in step() | analog-engine.ts | 414–417 | Met |
| 3.2.1: Elements read statePool.ag[] | analog-engine.ts | 414–417 | Met |
| 3.2.2: `tryOrderPromotion` inside LTE check | analog-engine.ts | 541 | Met |
| 3.2.2: Gate: `currentOrder===1 && newDt > 0.9*dt` | analog-engine.ts | 540 | Met |
| 3.2.2: Called BEFORE `shouldReject()` | analog-engine.ts | 540–544 | Met |
| 3.2.2: No post-acceptance order promotion | analog-engine.ts | (absent) | Met |
