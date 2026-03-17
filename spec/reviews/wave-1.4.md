# Review Report: Wave 1.4 — Companion Models + Timestep Control

## Summary

| Item | Value |
|------|-------|
| Tasks reviewed | 2 (Task 1.4.1, Task 1.4.2) |
| Files reviewed | 5 (integration.ts, timestep.ts, test-elements.ts, integration.test.ts, timestep.test.ts) |
| Violations | 4 |
| Gaps | 3 |
| Weak tests | 1 |
| Legacy references | 0 |
| **Verdict** | **has-violations** |

---

## Violations

### V1 — Historical-provenance comment (major)

**File**: `src/analog/test-elements.ts`, line 461
**Rule**: Code Hygiene — "No historical-provenance comments. Any comment describing what code replaced, what it used to do, why it changed, or where it came from is banned."
**Evidence**:
```
// iPrev not tracked in this simple test element (BDF-2 needs it).
```
This comment describes a deliberate omission: it names the shortcut ("not tracked"), identifies the affected feature ("BDF-2 needs it"), and thereby admits the element is intentionally incomplete for that use case. A comment justifying a rule-bent shortcut is proof of intentional rule-breaking, not a mitigating factor.

**Severity**: major

---

### V2 — Justification comment for warm-start approximation (minor)

**File**: `src/analog/test-elements.ts`, lines 364–366
**Rule**: Code Hygiene — "No historical-provenance comments" / "Comments exist ONLY to explain complicated code to future developers. They never describe what was changed, what was removed, or historical behaviour."
**Evidence**:
```typescript
      // For BDF-2: on the first call there is no valid v(n-1), so we use v(n)
      // as a warm-start approximation (equivalent to assuming the circuit was at
      // the same voltage one step earlier — the DC initial condition).
```
This comment explains why a shortcut (`vPrev = vNow` on first call) is used, and explicitly characterises it as an "approximation." Comments that explain why a rule was bent ("no valid v(n-1)") are a red flag per reviewer posture. It is an explanatory rationale for a shortcut, not an explanation of complicated algorithmic code.

**Severity**: minor

---

### V3 — `computeNewDt` signature deviates from spec (major)

**File**: `src/analog/timestep.ts`, lines 99–103
**Rule**: Spec adherence — "Files to create" specification defines the method signature.
**Evidence**:

Spec (Task 1.4.2, `computeNewDt`):
```
computeNewDt(elements: readonly AnalogElement[], history: HistoryStore): number
```

Implementation:
```typescript
computeNewDt(
  elements: readonly AnalogElement[],
  history: HistoryStore,
  simTime: number = 0,
): number {
```

A third parameter `simTime: number = 0` was added without spec authorisation. The spec describes breakpoint clamping as `min(newDt, nextBreakpoint - simTime)` in the bullet points describing `computeNewDt`'s behaviour, but the spec's declared method signature has only two parameters. The implementation silently extended the public contract. The default value `= 0` means all callers not passing `simTime` will have broken breakpoint clamping (breakpoints will always clamp using 0 as simTime, giving `nextBreakpoint - 0` = full breakpoint time instead of remaining time).

**Severity**: major

---

### V4 — `makeInductor` always passes `iPrev = 0` hardcoded for BDF-2 (major)

**File**: `src/analog/test-elements.ts`, line 462
**Rule**: Completeness — "Never mark work as deferred, TODO, or 'not implemented.'" The spec requires BDF-2 history with `iPrev` for inductors equivalent to the capacitor's `vPrev` history. Passing a hardcoded zero is functionally equivalent to having no BDF-2 history at all for inductors.
**Evidence**:
```typescript
      // iPrev not tracked in this simple test element (BDF-2 needs it).
      ieq = inductorHistoryCurrent(inductance, dt, method, iNow, 0, vNow);
```

The spec (Task 1.4.1) states:
> `makeInductor(nodeA, nodeB, branchIdx, inductance): AnalogElement` — Same pattern with voltage/current roles swapped; adds MNA branch row

The "same pattern" refers to the capacitor's `makeCapacitor` which correctly tracks `vPrev` for BDF-2. `makeInductor` does not track `iPrev` at all — `iPrev` is always 0. This means BDF-2 integration is silently degraded to BDF-1 for inductors. The admitted shortcut is backed by the comment at line 461. Progress.md does not record this as a known gap or deferred item — it is undisclosed.

**Severity**: major

---

## Gaps

### G1 — `AutoSwitch::switches_to_trapezoidal_after_2_steps` test does not match spec description

**Spec requirement** (Task 1.4.2 Tests):
```
AutoSwitch::switches_to_trapezoidal_after_2_steps — call `accept()` twice; assert `currentMethod` is `'trapezoidal'`
```

**What was found** (`src/analog/__tests__/timestep.test.ts`, lines 237–255):
The test calls `accept()` **three** times before asserting `'trapezoidal'`. After two accepts the method is still `'bdf1'` (asserted at line 248); after the third accept it becomes `'trapezoidal'` (asserted at line 253–254).

The spec says "call `accept()` twice; assert `currentMethod` is `'trapezoidal'`", which implies that two accepted steps are sufficient to reach trapezoidal. The state machine implemented (steps 1–2 = BDF-1, step 3+ = trapezoidal) contradicts the spec test description. Either the state machine is wrong or the spec test description is wrong; either way the test as written does not match the spec test as written.

**File**: `src/analog/__tests__/timestep.test.ts`, lines 237–255

---

### G2 — `makeInductor` spec requirement for HistoryStore tracking not met

**Spec requirement** (Task 1.4.1):
> `makeInductor`: "Same pattern with voltage/current roles swapped; adds MNA branch row"

The capacitor's "pattern" (per the spec) includes BDF-2 history tracking via `vPrev`. The inductor's BDF-2 equivalent (`iPrev`) is not tracked — it is hardcoded to 0 (see V4). The spec's acceptance criterion states:

> "All three integration methods produce converging, stable results"

With `iPrev = 0`, BDF-2 for inductors degrades silently to BDF-1 — the BDF-2 code path exercises but does not compute BDF-2 results. This is not mentioned in progress.md as a gap or accepted deviation.

**File**: `src/analog/test-elements.ts`, line 462

---

### G3 — No BDF-2 transient test for inductor (RL circuit)

**Spec requirement** (Task 1.4.1 Tests):
```
RLCircuit::current_rise — RL circuit (R=1kΩ, L=1mH, Vs=5V): step and verify current at t=L/R within 5% of (Vs/R)·(1-e^(-1))
```

The spec lists a single RL circuit test. It does not explicitly require a BDF-2 RL test in the same way the RC circuit has both `exponential_decay_trapezoidal` and `exponential_decay_bdf2`. However, the RC circuit's BDF-2 test exercises the capacitor's `vPrev` tracking. There is no corresponding RL BDF-2 test, which means the inductor's broken BDF-2 path (`iPrev = 0`) is never exercised in a way that could detect the error. The RL test only uses trapezoidal (line 328), consistent with what the spec requires, but the absence of a BDF-2 RL test means the broken BDF-2 inductor path goes undetected by the test suite.

**Note**: This gap is a consequence of G2 — the broken iPrev tracking is masked by the lack of a BDF-2 RL test. Recorded separately for completeness.

**File**: `src/analog/__tests__/integration.test.ts`

---

## Weak Tests

### WT1 — `LTE::increases_dt_for_small_error` cap assertion is "capped at 4×" not "capped at 2×"

**Test path**: `src/analog/__tests__/timestep.test.ts::LTE::increases_dt_for_small_error`
**What is wrong**: The spec description says "assert computed dt > currentDt, capped at 2× currentDt". The test asserts `newDt <= 4 * dt` (line 113), consistent with the implementation's `[dt/4, 4*dt]` clamping formula. However, the spec test description says "capped at 2×". The test assertion is weaker than the spec-described assertion (4× is a looser upper bound than 2×). If the implementation returned 3× or 3.5× dt it would pass the test but violate the spec's described cap of 2×.

**Evidence**:
```typescript
    expect(newDt).toBeGreaterThan(dt);
    expect(newDt).toBeLessThanOrEqual(4 * dt);  // spec says "capped at 2×"
```

**Severity**: minor — the comment in the test body ("capped at 4× current dt") suggests the implementation intentionally uses 4× rather than 2×, indicating the spec test description (2×) and the implementation (4×) disagree. The test asserts the implementation's behaviour (4×), not the spec's (2×). One of them is wrong.

---

## Legacy References

None found.

---

## Notes on Extra Tests

The following tests in `integration.test.ts` are not listed in the spec but are present in the implementation (16 tests vs 10 specified):
- `CompanionModels::capacitor_bdf1_history_current`
- `CompanionModels::capacitor_trapezoidal_history_current`
- `CompanionModels::capacitor_bdf2_history_current`
- `CompanionModels::inductor_bdf1_history_current`
- `HistoryStore::initial_values_are_zero`
- `HistoryStore::push_three_times_correct_history`

These are additional tests not required by the spec. Extra tests are not a violation — they expand coverage. They are recorded here for completeness.

The timestep.test.ts file has exactly 16 tests matching the 16 specified by the spec.

---

## Acceptance Criteria Audit

### Task 1.4.1 Acceptance Criteria

| Criterion | Status |
|-----------|--------|
| Companion model coefficients match circuits-engine-spec.md section 4 exactly | PASS — coefficient formulas verified for all 3 methods, capacitor and inductor |
| RC circuit transient matches analytical exponential decay within 5% at t=RC | PASS — tested with both trapezoidal and BDF-2 |
| RL circuit transient matches analytical current rise within 5% at t=L/R | PASS — tested with trapezoidal only |
| BDF-2 history uses pointer swap, not array copy (zero allocation per timestep) | PASS — `HistoryStore.push()` toggles `_slotIsA` and writes into the new slot; no array copies |
| All three integration methods produce converging, stable results | PARTIAL FAIL — capacitor BDF-2 converges; inductor BDF-2 silently degrades to BDF-1 behaviour because iPrev is hardcoded to 0 (G2, V4) |

### Task 1.4.2 Acceptance Criteria

| Criterion | Status |
|-----------|--------|
| LTE estimation matches circuits-engine-spec.md section 5 formulas | PASS — formula `0.9 * dt * (tol/error)^(1/3)` correctly implemented |
| Timestep rejection reports via return value; state rollback is caller's responsibility | PASS — `reject()` returns new dt, no rollback performed |
| Auto-switching follows the state machine: BDF-1 (2 steps) → trapezoidal → BDF-2 (on ringing) → trapezoidal (after 5 stable) | PARTIAL — state machine works correctly in implementation but state transition to trapezoidal requires 3 accepted steps, not 2 as spec test description states (G1) |
| Breakpoints clamp dt so steps land exactly at registered times | PARTIAL — logic is correct but `computeNewDt` signature was extended with undocumented `simTime` parameter; callers omitting it get broken clamping (V3) |
| Diagnostic attribution identifies which element forced the timestep change via `largestErrorElement` | PASS — `largestErrorElement` getter correctly tracks the element with max LTE |
