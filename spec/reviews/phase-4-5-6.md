# Review Report: Phases 4, 5, 6 — DCOP Flow + UIC/Nodesets + Extended Capabilities

## Summary

| Field | Value |
|-------|-------|
| Tasks reviewed | 9 (4.1.1, 4.1.2, 4.1.3, 5.1.1, 5.1.2, 6.1.1, 6.1.2, 6.2.1, 6.2.2) |
| Violations — critical | 0 |
| Violations — major | 4 |
| Violations — minor | 3 |
| Gaps | 3 |
| Weak tests | 5 |
| Legacy references | 0 |
| Verdict | has-violations |

---

## Violations

### V-001 — Major: cktop() signature deviates from spec

**File**: `src/solver/analog/dc-operating-point.ts`, line 255

**Rule**: Spec adherence — wave-4.md §2.1 specifies explicit `firstMode` and `continueMode` parameters

**Evidence**:
```typescript
function cktop(
  opts: CKTopCallOptions,
  maxIterations: number,
): { converged: boolean; iterations: number; voltages: Float64Array }
```

**Spec required** (wave-4.md §2.1):
```typescript
function cktop(
  opts: CKTopOptions,
  firstMode: InitMode,    // e.g. "initJct"
  continueMode: InitMode, // e.g. "initFloat"
  maxIter: number,
): CKTopResult
```

The implementation's `cktop()` takes only two parameters: `opts` and `maxIterations`. The spec mandates four parameters including explicit `firstMode` and `continueMode` `InitMode` arguments that drive `pool.initMode = firstMode` at entry inside `cktop()`. The implementation instead inlines the mode setup outside `cktop()` via a ladder object constructed in `solveDcOperatingPoint()`. The spec's `pool.initMode = firstMode` assignment is not present inside `cktop()` — the ladder pre-configures `initMode` before calling `cktop()`. This is a structural deviation from the specified function contract.

**Severity**: Major

---

### V-002 — Major: noOpIter fast-path returns zero-valued voltages instead of current voltages

**File**: `src/solver/analog/dc-operating-point.ts`, lines 259–265

**Rule**: Spec adherence — wave-4.md §2.1: "When params.noOpIter is true, returns immediately with converged=true and the current voltages unchanged"

**Evidence**:
```typescript
if (opts.params.noOpIter) {
  return {
    converged: true,
    iterations: 0,
    voltages: new Float64Array(opts.nrBase.matrixSize),  // always zero-filled
  };
}
```

**Spec required** (wave-4.md §2.1):
```typescript
return { converged: true, iterations: 0, voltages: opts.voltages };
```

The spec says the current (pre-existing) voltages must be returned unchanged. The implementation allocates a fresh zero-filled `Float64Array`, discarding any prior voltage state. This violates the noOpIter semantic: when a circuit is pre-initialized with UIC, the voltages at entry should pass through as the result, not zeros. The test `noOpIter_skips_all_nr_and_returns_converged` only checks `result.converged` and `result.iterations` — it does not assert `result.nodeVoltages` content, so this violation is untested.

**Severity**: Major

---

### V-003 — Major: cktncDump() called with zero-voltage arguments at the failure path

**File**: `src/solver/analog/dc-operating-point.ts`, lines 558–567

**Rule**: Spec adherence — wave-4.md §2.5 requires actual last voltages and prevVoltages at failure

**Evidence**:
```typescript
const zeroVoltages = new Float64Array(matrixSize);
const ncNodes = cktncDump(
  zeroVoltages,
  zeroVoltages,    // delta = 0 everywhere → always returns empty array
  params.reltol,
  params.voltTol,
  params.abstol,
  nodeCount,
  matrixSize,
);
```

**Spec required** (wave-4.md §2.5): `cktncDump(elements, voltages, prevVoltages, ...)` using the actual last `voltages` and `prevVoltages` from the failed solve attempt.

Both arguments are zero-filled fresh arrays. Since `delta = |voltages[i] - prevVoltages[i]| = 0` everywhere, `cktncDump` always returns an empty array at the failure path, producing a summary with no non-converged node detail. This defeats the entire diagnostic purpose of cktncDump. The function is correctly implemented but incorrectly called. The test `cktncDump_identifies_non_converged_nodes` tests cktncDump in isolation with real delta values — but does not test the call site in `solveDcOperatingPoint()`.

**Severity**: Major

---

### V-004 — Major: StatePoolRef interface not updated with state4..state7 accessors

**File**: `src/core/analog-types.ts`, lines 64–95

**Rule**: Spec adherence — wave-10.md §9.3: "Add accessors state4..state7" — the interface must be updated alongside the implementation

**Evidence** — `StatePoolRef` declares only state0..state3:
```typescript
export interface StatePoolRef {
  readonly states: readonly Float64Array[];
  readonly state0: Float64Array;
  readonly state1: Float64Array;
  readonly state2: Float64Array;
  readonly state3: Float64Array;
  readonly totalSlots: number;
  // state4, state5, state6, state7 are absent
}
```

The concrete `StatePool` class correctly adds `state4` through `state7` accessors (verified in `state-pool.ts` lines 70–73). However `StatePoolRef` — the forward reference interface used throughout core/ and passed to element factory functions — was not updated. Any code that holds a `StatePoolRef` typed reference cannot access the new arrays without unsafe casts. The spec's §9.3 says "Add accessors state4..state7" — the implementation in `StatePool` is correct, but the interface that consumers program against is incomplete.

**Severity**: Major

---

### V-005 — Minor: Comment containing banned word "fallback" in analog-engine.ts

**File**: `src/solver/analog/analog-engine.ts`, line 180

**Rule**: rules.md — "No `previously this was...` comments. Historical-provenance comments are dead-code markers." The ban on "fallback" in comments is categorical.

**Evidence**:
```
// because a silent fallback reassignment would hide future allocation
```

This line appears in a multi-line rationale comment explaining why an error is thrown. While the intent is a design rationale (not a backwards-compat shim), the rules.md categorical ban applies to the word "fallback" in all comments. The comment should be reworded to avoid the banned term.

**Severity**: Minor

---

### V-006 — Minor: _transientDcop() duplicates dcOperatingPoint() body verbatim

**File**: `src/solver/analog/analog-engine.ts`, lines 874–946

**Rule**: CLAUDE.md — "Always implement the cleanest final architecture. Never defer the real fix."

**Evidence**: `_transientDcop()` is approximately 70 lines duplicated from `dcOperatingPoint()`. Both methods call `solveDcOperatingPoint()` with identical arguments, run identical post-convergence `updateChargeFlux` loops, identical `statePool` seeding sequences, and identical `updateCompanion` seeding loops. The only difference is `_transientDcop()` omits the convergence-log block. The spec (wave-4.md §2.6) describes this as a distinct entry point calling `cktop()` with MODETRANOP flags — but no MODETRANOP differentiation is implemented at all; it is a verbatim copy with one block removed. The correct architecture would extract the shared post-convergence seeding into a private helper and have both methods call it.

**Severity**: Minor

---

### V-007 — Minor: `(statePool as any).initMode` casts in dc-operating-point.ts gmin/src helpers

**File**: `src/solver/analog/dc-operating-point.ts`, lines 643–645, 675–677, 813–815, 859–861, 933, 975, 989 (7 occurrences)

**Rule**: Code hygiene — `as any` bypasses TypeScript type safety in critical production paths

**Evidence** (representative):
```typescript
if (statePool && 'initMode' in statePool) {
  (statePool as any).initMode = "initJct";
}
```

The `statePool` parameter type in the internal helpers (`dynamicGmin`, `spice3Gmin`, `spice3Src`, `gillespieSrc`) is `{ state0: Float64Array; reset(): void } | null | undefined` — it deliberately excludes `initMode`. A `as any` cast is then required to write `initMode`. The correct fix is to include `initMode?` in the helper parameter type. The `as any` pattern bypasses TypeScript type safety in the solver's hot convergence paths.

**Severity**: Minor

---

## Gaps

### G-001: noOpIter test does not verify that voltages are returned unchanged

**Spec requirement** (wave-4.md §2.1): noOpIter returns `opts.voltages` — the current voltages unchanged.

**What was found**: Test `noOpIter_skips_all_nr_and_returns_converged` only asserts `result.converged` and `result.iterations`. It does not assert `result.nodeVoltages` content. Because the implementation returns `new Float64Array(matrixSize)` (zeros) instead of the current voltages, a test verifying voltage content would catch violation V-002.

**File**: `src/solver/analog/__tests__/dc-operating-point.test.ts`, line 495 (test body lines 507–521)

---

### G-002: No dedicated tests for _transientDcop()

**Spec requirement** (wave-4.md §2.6): "Add `_transientDcop()` in `analog-engine.ts` that calls `cktop()` with `MODETRANOP|MODEINITJCT`."

**What was found**: progress.md entry for task 4.1.3 states "Tests: 16/16 passing (covered by Task 4.1.1 test run)." No test exercises `_transientDcop()` on `MNAEngine` directly. The task 4.1.1 tests only cover `solveDcOperatingPoint()`, `cktncDump()`, `noOpIter`, and `dcopFinalize`. The method is public and is the spec-mandated separate transient-DCOP entry point. Its behavioral difference from `dcOperatingPoint()` (if any) is entirely untested.

**File**: `src/solver/analog/analog-engine.ts` (lines 874–946); no test file covers `_transientDcop()`

---

### G-003: integrateCapacitor() / integrateInductor() not extended for GEAR orders 3-6

**Spec requirement** (wave-10.md §9.2): "Extend `computeNIcomCof()` (from Wave 5) for GEAR 3-6." The spec also states elements that use GEAR must produce correct companion models.

**What was found**: `computeNIcomCof()` correctly handles `method === "gear"` via `solveGearVandermonde` (integration.ts line 432). However `integrateCapacitor()` and `integrateInductor()` — the per-element companion functions — handle only `order <= 1` (BDF-1), `method === "trapezoidal"`, and a BDF-2 else branch (lines 38–62). There is no GEAR branch. For GEAR orders 3-6, any element calling these functions directly would silently fall through to the BDF-2 code path. The architecture depends on elements reading from `statePool.ag[]` (populated by `computeNIcomCof`) rather than calling `integrateCapacitor`/`integrateInductor` directly — but the element-level functions are not updated and remain incorrect for GEAR, creating a silent correctness hazard for any element that uses them.

**File**: `src/solver/analog/integration.ts`, lines 23–118

---

## Weak Tests

### WT-001: `dcopFinalize_sets_initMode_to_transient_after_convergence` — statePool.initMode typed as literal `"transient"` preventing mutation

**Test path**: `src/solver/analog/__tests__/dc-operating-point.test.ts::DcOP::dcopFinalize_sets_initMode_to_transient_after_convergence`

**Issue**: The mock statePool declares `initMode: "transient" as const` which types the property as the literal type `"transient"`. TypeScript would reject assignment of any other string literal to this field at compile time, meaning `dcopFinalize()`'s `pool.initMode = "initSmsig"` assignment cannot type-check correctly against this mock. The test may pass at runtime because JavaScript is dynamically typed, but the mock is incorrectly typed for the test's intent. The fix is to use the full union type: `initMode: "transient" as "initJct" | "initFix" | "initFloat" | "initTran" | "initPred" | "initSmsig" | "transient"`.

**Evidence**:
```typescript
const statePool = {
  state0: new Float64Array(1),
  reset(): void { this.initMode = "transient"; },
  initMode: "transient" as const,  // locked to literal — incorrect for mutable state
};
```

---

### WT-002: `gmin_stepping_fallback` — includes "dc-op-failed" in success assertion

**Test path**: `src/solver/analog/__tests__/dc-operating-point.test.ts::DcOP::gmin_stepping_fallback`

**Issue**: The test asserts `result.converged === true` but then accepts `"dc-op-failed"` as a valid outcome code in the diagnostic check. These are mutually exclusive: a converged result cannot emit `dc-op-failed`. The assertion is weaker than it should be.

**Evidence**:
```typescript
expect(result.converged).toBe(true);
// ...
const outcomeCodes = ["dc-op-converged", "dc-op-gmin", "dc-op-source-step", "dc-op-failed"];
expect(diags.some(d => outcomeCodes.includes(d.code))).toBe(true);
```

---

### WT-003: `source_stepping_fallback` — trivially-true disjunction over all outcomes

**Test path**: `src/solver/analog/__tests__/dc-operating-point.test.ts::DcOP::source_stepping_fallback`

**Issue**: The core assertion is a disjunction over all four possible outcome codes. It passes for any valid execution and provides zero signal about whether gillespieSrc was specifically exercised.

**Evidence**:
```typescript
expect(
  diags.some(d => d.code === "dc-op-converged") ||
  diags.some(d => d.code === "dc-op-gmin") ||
  diags.some(d => d.code === "dc-op-source-step") ||
  diags.some(d => d.code === "dc-op-failed")
).toBe(true);
```

---

### WT-004: `failure_reports_blame` — does not test the failure or blame path

**Test path**: `src/solver/analog/__tests__/dc-operating-point.test.ts::DcOP::failure_reports_blame`

**Issue**: The test name promises "failure_reports_blame" — i.e., that `cktncDump` blame information appears in the failure diagnostic. The circuit used (5V source, 1kΩ, diode) routinely converges, so `dc-op-failed` is almost never reached. No assertion checks the `explanation` field of the failure diagnostic, the `ncSummary` string content, or that cktncDump data appeared in any message. The test only checks that some diagnostic of the right severity exists — which is checked by other tests too.

**Evidence**:
```typescript
if (result.converged) {
  expect(diags.some(d => successCodes.includes(d.code))).toBe(true);
  const successDiag = diags.find(...)!;
  expect(["info", "warning"]).toContain(successDiag.severity);
  // No blame or ncSummary content checked
}
```

---

### WT-005: `state-pool.test.ts` constructor test name misrepresents 8-array pool

**Test path**: `src/solver/analog/__tests__/state-pool.test.ts::StatePool::constructor::allocates four Float64Array vectors of the given size`

**Issue**: The test name says "allocates four Float64Array vectors" but StatePool now allocates 8. The test body only asserts state0..state3. A separate test for state4..state7 was added, but the original test retains a factually incorrect name and incomplete assertions. Test names are documentation — this misleads readers about the pool's actual capacity.

**Evidence**:
```typescript
it('allocates four Float64Array vectors of the given size', () => {
  const pool = new StatePool(10);
  expect(pool.state0).toBeInstanceOf(Float64Array);
  expect(pool.state1).toBeInstanceOf(Float64Array);
  expect(pool.state2).toBeInstanceOf(Float64Array);
  expect(pool.state3).toBeInstanceOf(Float64Array);
  // state4..state7 not checked in this test
```

---

## Legacy References

None found in the files modified by Phases 4, 5, and 6. All occurrences of "fallback" in the scanned files refer to the legitimate DCOP three-level fallback strategy (domain terminology) or to pre-existing behavioral element code outside the review scope. No historical-provenance shims, re-exports, backwards-compatibility wrappers, or transitional dead code was identified.
