# Review Report: Phase 6 — Engine integration (checkpoint/rollback/acceptTimestep + Readonly narrowing)

## Summary

| Item | Value |
|------|-------|
| Tasks reviewed | 4 (G1, W6T1, W6T2, W6T3) |
| Violations | 7 (0 critical, 3 major, 4 minor) |
| Gaps | 3 |
| Weak tests | 3 |
| Legacy references | 4 |
| Verdict | **has-violations** |

---

## Violations

### V1 — MAJOR: Historical-provenance comment in analog-engine.ts field declaration block

**File:** `src/solver/analog/analog-engine.ts`  
**Lines:** 87-92

**Rule violated:** Rules — No historical-provenance comments. Any comment describing what code replaced, what it used to do, why it changed, or where it came from is banned.

**Evidence (lines 87-92):**
```
// `_stateCheckpoint` replaces the old `StatePool.checkpoint()` allocation:
// instead of allocating a fresh Float64Array every step to snapshot
// `statePool.state0` (which was done unconditionally even when no rollback
// occurred), we keep a persistent scratch buffer owned by the engine and
// copy into it via `.set()`.
```

The comment names the removed API (`StatePool.checkpoint()`), describes what it used to do (allocating a fresh Float64Array every step), and explains what replaced it. This is a textbook historical-provenance comment: it describes what changed, what was removed, and why.

**Severity:** Major

---

### V2 — MAJOR: Historical-provenance comment — "legacy r variable"

**File:** `src/solver/analog/analog-engine.ts`  
**Line:** 352

**Rule violated:** Rules — No historical-provenance comments.

**Evidence (line 352):**
```
// convert to the legacy `r` variable (r >= 1 = accept) so the existing
// `shouldReject` / `computeNewDt` plumbing works unchanged.
```

The comment explicitly names this as a 'legacy' variable and explains that the old name is preserved to avoid changing other code ('so the existing plumbing works unchanged'), documenting an in-flight migration where both naming conventions coexist. A justification comment that names the legacy API makes the violation worse, not better.

**Severity:** Major

---

### V3 — MAJOR: compiled-analog-circuit.ts backwards-compatibility fallback not remediated (V5 from Wave 6.1)

**File:** `src/solver/analog/compiled-analog-circuit.ts`  
**Lines:** 133, 150

**Rule violated:** Rules — No fallbacks. No backwards compatibility shims. No safety wrappers.

**Evidence:**
```typescript
statePool?: StatePool;                                    // line 133 - optional param
// ...
this.statePool = params.statePool ?? new StatePool(0);   // line 150 - silent fallback
```

This was flagged as V5 (minor) in the Wave 6.1 review. `progress.md` records that `G1 (review gap)` and `V2+G3` were fixed but V5 is not listed as remediated. The fallback `new StatePool(0)` silently produces a zero-slot pool instead of failing when a pool is absent. The spec requires every compiled circuit to carry a properly allocated pool.

**Severity:** Major

---

### V4 — MINOR: analog-engine.ts step() uses ?? null cast to bypass the non-optional statePool contract

**File:** `src/solver/analog/analog-engine.ts`  
**Lines:** 249, 288, 361

**Rule violated:** Rules — No fallbacks. No backwards compatibility shims.

The `ConcreteCompiledAnalogCircuit` interface in the same file (line 52) declares `readonly statePool: StatePool` as non-optional. Yet every access in `step()` casts to `CompiledWithBridges` and applies `?? null`:

```typescript
const statePool = (this._compiled as CompiledWithBridges).statePool ?? null;
```

The cast to the concrete class (where statePool is set via the V3 fallback) allows the null guard to be reached. If the interface contract were enforced, every circuit would have a real pool, the null branch would be unreachable, and the guard is a backwards-compatibility shim. The null path should be removed.

**Severity:** Minor

---

### V5 — MINOR: state-pool.test.ts historical-provenance comment

**File:** `src/solver/analog/__tests__/state-pool.test.ts`  
**Lines:** 35-37

**Rule violated:** Rules — No historical-provenance comments.

**Evidence:**
```
// Note: checkpoint()/rollback() were removed from StatePool. The engine now
// owns a hoisted per-instance checkpoint buffer (see MNAEngine._stateCheckpoint)
// so the pool itself is pure state storage. Tests for the old API are deleted.
```

Names removed APIs, describes what replaced them, explains the reason for change, and documents deleted tests. All four clauses are historical-provenance content — none explain complicated code to future developers.

**Severity:** Minor

---

### V6 — MINOR: Spec-required StatePool.checkpoint() and StatePool.rollback() methods not implemented

**File:** `src/solver/analog/state-pool.ts`

**Rule violated:** Completeness — the Phase 6 spec pseudocode refers to `statePool.checkpoint(simTime)` and `statePool.rollback(checkpoint)` as method calls on the StatePool object. The engine instead inlines equivalent operations directly: `this._stateCheckpoint.set(statePool.state0)` and `statePool.state0.set(this._stateCheckpoint)`.

The Phase 6 gate grep checks pass because the words appear in comments, not method calls. The inlined approach bypasses the `StateCheckpoint` interface entirely — the `simTime` field is never captured. The spec-defined `StateCheckpoint` interface is absent from the codebase.

Reported as minor (not critical) because the inlined approach is functionally correct for state0 rollback; however the spec interface contract is formally unfulfilled.

**Severity:** Minor

---

### V7 — MINOR: Capacitor stateSize is 5 (spec: 3); inductor stateSize is 4 (spec: 3)

**File:** `src/components/passives/capacitor.ts` line 152; `src/components/passives/inductor.ts` line 166

**Rule violated:** Spec adherence — Phase 5 gate slot table specifies stateSize 3 for both capacitor (GEQ, IEQ, V_PREV) and inductor (GEQ, IEQ, I_PREV). Implementations use stateSize 5 (capacitor: adds SLOT_I_PREV, SLOT_I_PREV_PREV) and stateSize 4 (inductor: adds SLOT_I_PREV_PREV). The extra slots support `getLteEstimate` LTE history introduced in Wave 6.1 but the spec slot table was never updated.

**Evidence:**
```typescript
readonly stateSize: number = 5;   // capacitor.ts line 152 -- spec says 3
readonly stateSize: number = 4;   // inductor.ts line 166 -- spec says 3
```

**Severity:** Minor

---

## Gaps

### G1 — W6T2: No test exercises the NR retry rollback path

**Spec requirement (Phase 6 gate / Test Strategy):**
> 'Circuit with NR retry path: confirm rollback() is called and state0 is restored.'
> 'Trigger an NR failure + retry path and confirm rollback restores state0.'

**What was found:** All 6 tests in `convergence-regression.test.ts` exercise happy-path convergence only. None force a convergence failure (e.g. by setting `maxIterations: 1` to guarantee NR non-convergence), then verify that `state0` is restored to checkpoint values before the re-stamp. The rollback path in `analog-engine.ts` lines 285-319 is entirely untested by W6T2.

**File:** `src/solver/analog/__tests__/convergence-regression.test.ts`

---

### G2 — W6T2: No test exercises the LTE rejection path or verifies rollback on LTE retry

**Spec requirement (Phase 6 gate):** The spec pseudocode shows the LTE rejection path calling `statePool.rollback(checkpoint)` before retrying. No test in `convergence-regression.test.ts` exercises this path.

**What was found:** The 6 tests cover: diode DC convergence, RC transient stability, state0 contents after DC op, state1 update after accepted step, 100-step stability, and reset. None configure a circuit that triggers LTE rejection (e.g. tight trtol or chargeTol) and verifies that state0 is rolled back before the retry NR solve.

**File:** `src/solver/analog/__tests__/convergence-regression.test.ts`

---

### G3 — state-pool.ts missing checkpoint() / rollback() methods and StateCheckpoint interface

**Spec requirement:** The spec (section 'StatePool class') defines:
```typescript
checkpoint(simTime: number): StateCheckpoint;
rollback(cp: StateCheckpoint): void;

interface StateCheckpoint {
  readonly state0: Float64Array;
  readonly simTime: number;
}
```

**What was found:** `state-pool.ts` exports only `StatePool` with `acceptTimestep()` and `reset()`. Neither `checkpoint()`, `rollback()`, nor the `StateCheckpoint` interface appear anywhere in the codebase. The `simTime` field is never captured.

**File:** `src/solver/analog/state-pool.ts`

---

## Weak Tests

### WT1 — RC circuit test has trivially true simTime assertion and loose voltage band

**Test path:** `src/solver/analog/__tests__/convergence-regression.test.ts::convergence regression::RC circuit runs transient steps stably with capacitor near Vs`  
**Lines:** 158-164

**Problem:** The assertions include:
```typescript
expect(engine.simTime).toBeGreaterThan(0);   // trivially true if any step runs
expect(v2).toBeGreaterThan(4.5);             // 10% lower bound
expect(v2).toBeLessThanOrEqual(5.01);        // loose upper bound
```

`expect(engine.simTime).toBeGreaterThan(0)` is trivially true the moment any step runs. The 10% voltage band passes even with significant drift. The tight-tolerance RC test in `mna-end-to-end.test.ts::rc_steady_state_no_drift` already checks driftPct < 0.1%. This test adds no W6T2-specific coverage.

---

### WT2 — 100-step stability test makes no pool state assertions

**Test path:** `src/solver/analog/__tests__/convergence-regression.test.ts::convergence regression::diode circuit runs 100 transient steps without error`  
**Lines:** 231-250

**Problem:** Verifies only that the engine does not crash and voltages remain within a wide band (v2 > 0.4, v2 < 1.0, v1 to 1 decimal place). Makes no assertion about state0 slot values at any accepted step, acceptTimestep() history shifting, or rollback correctness. None of the behaviors specific to W6T2 are covered.

**Evidence:**
```typescript
expect(engine.getState()).not.toBe(EngineState.ERROR);
expect(engine.simTime).toBeGreaterThan(0);
expect(v1).toBeCloseTo(5.0, 1);     // 0.1V tolerance
expect(v2).toBeGreaterThan(0.4);    // very loose
expect(v2).toBeLessThan(1.0);       // very loose
```

---

### WT3 — acceptTimestep test captures state0 value but never asserts it was shifted to state1

**Test path:** `src/solver/analog/__tests__/convergence-regression.test.ts::convergence regression::statePool state1 is updated after accepted transient step`  
**Lines:** 201-224

**Problem:** `state0VdBeforeStep` is captured at line 213 but never referenced in any assertion. The post-step check only verifies the value is in the forward-voltage range — which passes whether or not `acceptTimestep()` was called. The test should assert `state1[diodeBase + 0]` equals `state0VdBeforeStep`. As written, the captured variable is dead code.

**Evidence:**
```typescript
const state0VdBeforeStep = pool.state0[diodeBase + 0];  // captured -- never asserted
// ... engine.step() ...
const state1VdAfterStep = pool.state1[diodeBase + 0];
// MISSING: expect(state1VdAfterStep).toBeCloseTo(state0VdBeforeStep, ...)
expect(state1VdAfterStep).toBeGreaterThan(0.5);   // same range as initial DC op
expect(state1VdAfterStep).toBeLessThan(0.8);
```

---

## Legacy References

### LR1 — analog-engine.ts line 87: quotes removed API name StatePool.checkpoint()

**File:** `src/solver/analog/analog-engine.ts`  
**Line:** 87

**Quoted evidence:**
```
// `_stateCheckpoint` replaces the old `StatePool.checkpoint()` allocation:
```

Names a removed API by its former name. Banned historical-provenance reference.

---

### LR2 — analog-engine.ts line 352: 'the legacy r variable'

**File:** `src/solver/analog/analog-engine.ts`  
**Line:** 352

**Quoted evidence:**
```
// convert to the legacy `r` variable (r >= 1 = accept) so the existing
```

Names a variable as 'legacy' and explains that old code is preserved to avoid changing other paths. Banned historical-provenance reference.

---

### LR3 — state-pool.test.ts lines 35-37: removed-API provenance comment

**File:** `src/solver/analog/__tests__/state-pool.test.ts`  
**Lines:** 35-37

**Quoted evidence:**
```
// Note: checkpoint()/rollback() were removed from StatePool. The engine now
// owns a hoisted per-instance checkpoint buffer (see MNAEngine._stateCheckpoint)
// so the pool itself is pure state storage. Tests for the old API are deleted.
```

Names removed methods, describes what replaced them, and documents deleted tests. Three independent historical-provenance references in one block.

---

### LR4 — compiled-analog-circuit.ts lines 89-90: 'Replaces elementPinVertices' / 'coexists' (Wave 6.1 LR1/LR2 — not remediated)

**File:** `src/solver/analog/compiled-analog-circuit.ts`  
**Lines:** 89-90

**Quoted evidence (from Wave 6.1 review, confirmed still present):**
```
 *  Replaces elementPinVertices -- carries label, vertex, nodeId in one object.
 *  During migration, coexists with elementPinVertices. */
```

Flagged as LR1 and LR2 in the Wave 6.1 review. Not recorded as remediated in `progress.md`. `elementPinVertices` remains present in the file, confirming the migration is still incomplete.

---

## Hidden Bug Investigation: LTE History Slots on NR Retry Rollback

**Assignment:** Determine whether rollback on NR retry or LTE rejection accidentally clobbers SLOT_I_PREV/SLOT_I_PREV_PREV with stale values that corrupt history for subsequent retries.

### Finding: No hidden bug — checkpoint timing is correct

Both capacitor (`stampCompanion` lines 200-223) and inductor (`stampCompanion` lines 217-231) write SLOT_I_PREV and SLOT_I_PREV_PREV into `state0` during the stamp call.

The engine checkpoint is taken at `analog-engine.ts` lines 252-254, **before** any `stampCompanion` call (companions are stamped at lines 260-264). The checkpoint therefore always captures pre-stamp history slots — i.e., values from the last accepted step.

**NR retry execution trace:**
1. Line 253: `_stateCheckpoint.set(statePool.state0)` — snapshot includes unmodified SLOT_I_PREV from accepted history.
2. Line 263: `stampCompanion(dt, ...)` — overwrites SLOT_I_PREV and SLOT_I_PREV_PREV with current-step attempt values.
3. NR fails.
4. Line 289: `statePool.state0.set(this._stateCheckpoint)` — restores SLOT_I_PREV and SLOT_I_PREV_PREV to pre-stamp values. Correct.
5. Line 295: `stampCompanion(retryDt, ...)` — reads SLOT_I_PREV from restored snapshot, consistent with restored `_prevVoltages`.

**LTE rejection execution trace:** Same analysis applies. Checkpoint taken before first `stampCompanion`, so rollback at line 362 restores pre-attempt history. Re-stamp at line 368 reads correct history.

**Conclusion:** The pattern is correct. The invariant that makes it work is that `_stateCheckpoint.set(statePool.state0)` is always called before `stampCompanion`. If this ordering were ever reversed — checkpoint taken after stamp — the history slots would be corrupted on rollback. The ordering must be preserved in any future refactoring.

---

## Wave 6.1 Follow-up Re-verification

| Finding | Status |
|---------|--------|
| V2 + G3: LTE retry NR failure emits diagnostic + ERROR | **Fixed.** `analog-engine.ts` lines 389-405 confirm the `convergence-failed` diagnostic and `EngineState.ERROR` transition. |
| G1: `analog-engine-interface.test.ts` includes `statePool` field | **Fixed.** Test lines 88-92 include `statePool: { state0, state1, state2 }` in the literal. |
| V1: init() slot allocation shim replaced with throw | **Fixed per user acceptance.** Lines 181-189 throw on `stateBaseOffset < 0`. New surrounding comments (lines 163-175) introduce new violations flagged as V1/LR1 above. |
| V3: Historical-provenance comment in `compiled-analog-circuit.ts` lines 89-90 | **Not remediated.** Still present (flagged as LR4 above). |
| V5: `ConcreteCompiledAnalogCircuit` optional statePool fallback | **Not remediated.** `?? new StatePool(0)` at line 150 remains (flagged as V3 above). |