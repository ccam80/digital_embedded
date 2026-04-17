# Review Report: Phase 2 Wave 2.1 — NIiter Structural Alignment

**Date**: 2026-04-17
**Reviewer**: claude-orchestrator:reviewer (claude-sonnet-4-6)
**Scope**: Tasks 2.1.1, 2.1.2, 2.1.3 (Wave 2.1 only; Wave 2.2 is not yet implemented and is out of scope)

---

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 3 |
| Violations — critical | 3 |
| Violations — major | 1 |
| Violations — minor | 1 |
| Gaps | 1 |
| Weak tests | 3 |
| Legacy references | 2 |

**Verdict**: has-violations

---

## Violations

### V-01 — Critical: `shouldBypass` optional-chain call is a dead-code compatibility shim

**File**: `src/solver/analog/mna-assembler.ts:69`
**Rule**: Code Hygiene — "No fallbacks. No backwards compatibility shims." / "All replaced or edited code is removed entirely."
**Severity**: critical

Task 6.1.2 (also in this same batch, already completed and verified) deleted `shouldBypass` from the `AnalogElement` interface entirely. The current `element.ts` confirms `shouldBypass` is absent from the interface. Despite this deletion, `mna-assembler.ts` line 69 still calls `el.shouldBypass?.(voltages, prevVoltages)` via an optional chain:

```typescript
if (iteration > 0 && prevVoltages !== undefined && el.shouldBypass?.(voltages, prevVoltages)) {
  continue;
}
```

The `?.` operator is a backwards-compatibility shim that silently no-ops when the method no longer exists. The code decorating this call (the bypass `continue` branch) is dead code — `shouldBypass` can never return a truthy value through any currently-compiled element, because the method has been removed from the interface. The comment in the `stampAll` JSDoc at line 52 ("Used by `shouldBypass()` checks. When omitted, bypass is never triggered.") reinforces that the agent knowingly left this dead branch rather than deleting it. The `prevVoltages` parameter only exists in the public API of `stampAll` because of this dead path.

**Evidence**:
```typescript
// mna-assembler.ts:52 (JSDoc for prevVoltages parameter)
 *   Used by shouldBypass() checks. When omitted, bypass is never triggered.

// mna-assembler.ts:69 (dead optional-chain call)
      if (iteration > 0 && prevVoltages !== undefined && el.shouldBypass?.(voltages, prevVoltages)) {
        continue;
      }
```

---

### V-02 — Critical: Historical-provenance comment in `mna-assembler.ts:41` is a dead-code marker

**File**: `src/solver/analog/mna-assembler.ts:41`
**Rule**: Code Hygiene — "Historical-provenance comments are dead-code markers." / "No `# previously this was...` comments."
**Severity**: critical

The JSDoc for `stampAll` contains the comment:

```
   * Called every NR iteration. Replaces the old separate linear/nonlinear
   * stamp hoisting with a single unconditional pass matching ngspice CKTload.
```

The phrase "Replaces the old separate linear/nonlinear stamp hoisting" is a historical-provenance comment describing what this code replaced. Per the rules, this is not just a comment problem — it is a dead-code marker. The comment exists because the multi-pass/hoisting code that `stampAll` replaced was not fully deleted; instead `stampAll` itself is still a 3-pass method (calling `updateOperatingPoints`, then a `stamp` loop, then `stampNonlinear`, then `stampReactiveCompanion` conditionally). The Wave 2.2 intent (true single-pass cktLoad) has not landed, yet Wave 2.1 implementers modified this file (adding the `shouldBypass` call) and left this provenance comment in place. The comment is proof the agent knew the implementation was not a true single-pass replacement.

**Evidence**:
```typescript
// mna-assembler.ts:38-42
  /**
   * Unified CKTload equivalent: clear the matrix, update operating points,
   * stamp ALL element contributions unconditionally, and finalize.
   *
   * Called every NR iteration. Replaces the old separate linear/nonlinear
   * stamp hoisting with a single unconditional pass matching ngspice CKTload.
```

---

### V-03 — Critical: Historical-provenance comment in `ckt-context.ts:149` describes future deletion

**File**: `src/solver/analog/ckt-context.ts:149`
**Rule**: Code Hygiene — "Historical-provenance comments are dead-code markers." / "Comments never describe what was changed, what was removed, or historical behaviour."
**Severity**: critical

The JSDoc for the `assembler` field reads:

```typescript
  /**
   * MNA matrix assembler (hoisted to ctx in Phase 1, deleted in Phase 2 Wave 2.2
   * when cktLoad replaces stampAll).
   */
  assembler: MNAAssembler = null!;
```

This comment is a forward-deletion annotation — it explicitly says this field "will be deleted in Phase 2 Wave 2.2." This is a deferral comment in disguise: it justifies retaining dead-weight infrastructure by pointing at a future wave. Per the rules, such comments are banned because they mark transitional code that was left in place rather than completing the work. The comment also describes how the field was introduced ("hoisted to ctx in Phase 1"), which is a historical-provenance statement.

**Evidence**:
```typescript
// ckt-context.ts:148-151
  /**
   * MNA matrix assembler (hoisted to ctx in Phase 1, deleted in Phase 2 Wave 2.2
   * when cktLoad replaces stampAll).
   */
  assembler: MNAAssembler = null!;
```

Note: The `assembler` field itself is required for Wave 2.1 (the NR loop still uses `assembler.stampAll`, `assembler.noncon`, and `assembler.checkAllConverged`). The violation here is the provenance/deferral comment, not the field's existence. The comment must be replaced with a mechanical description of what the field is, with no mention of what phase introduced it or what phase will delete it.

---

### V-04 — Major: `mna-assembler.ts` header claims "Unified CKTload equivalent" — the method is a 3-pass walk

**File**: `src/solver/analog/mna-assembler.ts:6-10` (file header) and `mna-assembler.ts:38` (method JSDoc)
**Rule**: Code Hygiene — "Comments exist ONLY to explain complicated code to future developers. They never describe what was changed, what was removed, or historical behaviour." / CLAUDE.md "No Pragmatic Patches"
**Severity**: major

The file-level JSDoc (lines 6-10) and the `stampAll` method JSDoc (line 38) both claim `stampAll` is a "unified CKTload equivalent" — but the implementation is a 3-pass walk:
1. `updateOperatingPoints` loop (nonlinear elements only)
2. Element stamp loop (calling `el.stamp`, `el.stampNonlinear`, `el.stampReactiveCompanion` separately)
3. `solver.finalize()`

The real single-pass `cktLoad` (Wave 2.2) has not landed. The comment is a lie about the current implementation state. While Wave 2.2 work is legitimately deferred per the scope boundary note, the comment fraudulently describes the current code as already being what Wave 2.2 is supposed to deliver.

**Evidence**:
```typescript
// mna-assembler.ts:6-10 (file header)
 * Orchestrates the stamp protocol used by the Newton-Raphson loop:
 *
 *   `stampAll` — called every NR iteration (unified CKTload equivalent).
 *                Clears the matrix, updates operating points, stamps all
 *                element contributions (linear + nonlinear + reactive companion)
 *                unconditionally, and finalizes the matrix for factorization.

// mna-assembler.ts:38 (method JSDoc first line)
   * Unified CKTload equivalent: clear the matrix, update operating points,
```

The actual implementation (lines 62-82) performs three separate passes over different element subsets, which does not match ngspice CKTload.

---

### V-05 — Minor: `pnjlim_passes_small_step` uses `toBeCloseTo(0.65, 10)` instead of exact `toBe`

**File**: `src/solver/analog/__tests__/newton-raphson.test.ts:97`
**Rule**: Testing — "Test the specific: exact values, exact types, exact error messages where applicable." / "No `pytest.approx()` with loose tolerances to make tests pass."
**Severity**: minor

The pre-existing `pnjlim_passes_small_step` test (not one of the 4 spec-required new tests) uses `toBeCloseTo(0.65, 10)` rather than exact `toBe(0.65)`. When `limited === false`, `pnjlim` returns `vnew` unchanged — the returned value is IEEE-754 identical to the input `0.65`. There is no floating-point arithmetic involved in the no-limiting path; `toBeCloseTo` with precision 10 is unnecessarily tolerant for an identity return. The 4 new spec-required tests correctly use `toBe` for exact assertions. This test was not added in Wave 2.1 but it is in the same file that Wave 2.1 modified, making it in-scope for this review.

**Evidence**:
```typescript
// newton-raphson.test.ts:96-98
    const result = pnjlim(0.65, 0.60, 0.026, 0.6);
    expect(result.value).toBeCloseTo(0.65, 10);
    expect(result.limited).toBe(false);
```

---

## Gaps

### G-01: `ipass_skipped_without_nodesets` does not assert the convergence iteration count — the no-ipass claim is unverified

**Spec requirement** (Task 2.1.3): "Assert that after initFix→initFloat transition, convergence returns immediately on noncon===0 (no extra ipass iteration)."

**What was found** (`src/solver/analog/__tests__/newton-raphson.test.ts:567-572`):

The test records `initFloatBeginIter` and `convergeIter` but never asserts a relationship between them. The test only asserts `ctx.hadNodeset === false` and `ctx.nrResult.converged === true`. It does not assert that `convergeIter === initFloatBeginIter` (or any quantitative claim that convergence was immediate), which is the spec's stated requirement. The test therefore passes vacuously — the ipass gate might be firing and still pass, because the assertion is absent.

**Evidence**:
```typescript
// newton-raphson.test.ts:565-573
    newtonRaphson(ctx);

    expect(ctx.nrResult.converged).toBe(true);
    // With no nodesets, ipass gate never fires — convergence happens without extra iteration
    // convergeIter - initFloatBeginIter should be minimal (0 or 1 extra NR steps, not an ipass-forced extra)
    expect(ctx.hadNodeset).toBe(false);
    // NOTE: convergeIter and initFloatBeginIter are tracked but never compared
```

The comment says "should be minimal" but there is no `expect(convergeIter)` assertion anywhere in this test. `convergeIter` and `initFloatBeginIter` are assigned in the ladder callbacks and never read by any assertion.

**File**: `src/solver/analog/__tests__/newton-raphson.test.ts` (ipass_skipped_without_nodesets test body)

---

## Weak Tests

### W-01: `fetlim_clamps_above_threshold` — second assertion uses `toBeCloseTo` for an exact arithmetic result

**Test path**: `src/solver/analog/__tests__/newton-raphson.test.ts::NR::fetlim_clamps_above_threshold` (line 116)
**Problem**: `expect(result3).toBeCloseTo(5.0 + (Math.abs(2 * (5.0 - 0.7)) + 2), 10)` computes the expected value in floating-point (identical operations to the implementation) and uses `toBeCloseTo` with precision 10. This is an implementation-mirroring assertion — the expected value is computed using the same formula as the code under test. When implementation and expected share the same arithmetic path, `toBeCloseTo` cannot catch an off-by-one or wrong operator in either. The test should use a pre-computed literal value.
**Evidence**:
```typescript
    const result3 = fetlim(20.0, 5.0, 0.7);
    expect(result3).toBeCloseTo(5.0 + (Math.abs(2 * (5.0 - 0.7)) + 2), 10);
```

---

### W-02: `ipass_skipped_without_nodesets` — key assertion is entirely absent (see also G-01)

**Test path**: `src/solver/analog/__tests__/newton-raphson.test.ts::ipass hadNodeset gate::ipass_skipped_without_nodesets`
**Problem**: The test declares and populates `initFloatBeginIter` and `convergeIter` variables inside the ladder callbacks but never asserts their values. The spec requires asserting that convergence is immediate (no extra ipass iteration). The comment in the test acknowledges the intent but the `expect()` call is missing entirely. This is a trivially-passing test that verifies nothing about the behaviour it claims to cover.
**Evidence**:
```typescript
    let initFloatBeginIter = -1;
    let convergeIter = -1;
    // ... ladder callbacks set these ...
    newtonRaphson(ctx);
    expect(ctx.nrResult.converged).toBe(true);
    expect(ctx.hadNodeset).toBe(false);
    // convergeIter and initFloatBeginIter are NEVER read by any expect()
```

---

### W-03: `applyNodesetsAndICs_stamps_nodeset_in_initJct_mode` — RHS assertion uses `toBeCloseTo` with precision 0

**Test path**: `src/solver/analog/__tests__/newton-raphson.test.ts::NR::applyNodesetsAndICs_stamps_nodeset_in_initJct_mode` (lines 392-393)
**Problem**: `expect(rhs[1]).toBeCloseTo(G_NODESET * 2.5, 0)` uses precision 0, meaning the assertion tolerates values within ±0.5 of `2.5e10`. This is 5 orders of magnitude looser than what `toBeCloseTo` at precision 10 would give, and vastly looser than a direct `toBe` assertion on an exact integer multiplication. The value `1e10 * 2.5 = 2.5e10` is exactly representable in IEEE-754 double. The same loose-precision pattern appears in all four `applyNodesetsAndICs_*` tests (lines 393, 405, 428, 440-441). These were not added in Wave 2.1 but are in the Wave 2.1-modified test file.
**Evidence**:
```typescript
    expect(rhs[1]).toBeCloseTo(G_NODESET * 2.5, 0);  // precision=0: ±5e9 tolerance
```

---

## Legacy References

### L-01: `mna-assembler.ts:41` — "Replaces the old separate linear/nonlinear stamp hoisting"

**File**: `src/solver/analog/mna-assembler.ts:41`
**Stale reference**: `"Called every NR iteration. Replaces the old separate linear/nonlinear stamp hoisting with a single unconditional pass matching ngspice CKTload."`

This is a historical description of what the method replaced. The old multi-pass hoisting code no longer exists in this file, but the comment describes the past state of the codebase. This is the definition of a banned historical-provenance comment.

---

### L-02: `ckt-context.ts:149` — "hoisted to ctx in Phase 1, deleted in Phase 2 Wave 2.2"

**File**: `src/solver/analog/ckt-context.ts:149`
**Stale reference**: `"MNA matrix assembler (hoisted to ctx in Phase 1, deleted in Phase 2 Wave 2.2 when cktLoad replaces stampAll)."`

This comment describes the field's history (Phase 1 introduction) and announces its future deletion (Phase 2 Wave 2.2). Both clauses are banned: the first is a historical-provenance statement; the second is a deferral annotation.

---

## Notes on Wave 2.1 Tasks — Positive Findings

The three core algorithmic changes (pnjlim rewrite, fetlim formula fix, hadNodeset gate) are correctly implemented:

- **Task 2.1.1 (pnjlim)**: The implementation in `newton-raphson.ts:126-146` is a direct port of ngspice `DEVpnjlim` (devsup.c:50-58). The variable-mapping table is present as a comment (lines 118-125). The forward-bias branch, arg-le-zero branch, cold-junction branch, and no-limiting path all match the ngspice C code. The 4 spec-required tests (`pnjlim_matches_ngspice_forward_bias`, `pnjlim_matches_ngspice_arg_le_zero_branch`, `pnjlim_matches_ngspice_cold_junction_branch`, `pnjlim_no_limiting_when_below_vcrit`) all use exact `toBe` assertions with pre-computed IEEE-754 reference values.

- **Task 2.1.2 (fetlim)**: The formula `const vtstlo = vtsthi / 2 + 2` at line 172 matches ngspice `DEVfetlim` exactly. The 2 spec-required tests are present and test the correct values.

- **Task 2.1.3 (hadNodeset gate)**: The gate `if (ctx.isDcOp && ctx.hadNodeset && ipass > 0)` at `newton-raphson.ts:501` matches ngspice niiter.c:1050-1052. `hadNodeset` is correctly derived from `nodesets.size > 0` via `updateHadNodeset()` in `ckt-context.ts:581-583`. `ipass_fires_with_nodesets` test asserts `convergeIter >= initFloatBeginIter + 1` which is a meaningful quantitative assertion.

The `shouldBypass` issue (V-01) is confirmed: `shouldBypass` does not appear anywhere in the current `element.ts` interface (grep returned no matches), confirming the optional-chain call in `mna-assembler.ts:69` is dead code left from before Task 6.1.2 deleted the method.
