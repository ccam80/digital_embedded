# Review Report: Phase 4 — DC Operating Point Alignment

## Summary

- **Tasks reviewed**: 7 (4.1.1, 4.1.2, 4.2.1, 4.2.2, 4.2.3, 4.3.1, 4.4.1, 4.5.1)
- **Violations**: 8 (0 critical, 3 major, 5 minor)
- **Gaps**: 2
- **Weak tests**: 6
- **Legacy references**: 0
- **Verdict**: has-violations

---

## Violations

### V-1 — Major
- **File**: `src/solver/analog/__tests__/dc-operating-point.test.ts`, line 710
- **Rule violated**: Rules §Code Hygiene — "No `# TODO`, `# FIXME`, `# HACK` comments." The SURFACED comment pattern is a HACK-marker: it documents that the agent knew it could not properly force the tested code path and chose to proceed anyway rather than stopping and escalating.
- **Evidence**: `// SURFACED: Cannot force dynamicGmin path without out-of-scope mock; reporting red-detecting-real-divergence per tests-red protocol`
- **Severity**: major
- **Context**: This comment decorates the `dynamicGmin_factor_cap_uses_param` test body. The agent could not force `dynamicGmin` to be entered with `makeGminDependentElement` as constructed (see V-4 for the related nodeCount bug), and instead of stopping, it left the comment and shipped a weakened test that may silently pass even if the direct NR path is taken.

### V-2 — Major
- **File**: `src/solver/analog/__tests__/dc-operating-point.test.ts`, line 758
- **Rule violated**: Rules §Code Hygiene — banned HACK-marker comment.
- **Evidence**: `// SURFACED: Cannot force dynamicGmin path without out-of-scope mock; reporting red-detecting-real-divergence per tests-red protocol`
- **Severity**: major
- **Context**: Decorates `dynamicGmin_clean_solve_uses_dcMaxIter`. Same problem — the agent could not reliably force the dynamicGmin path. The test never asserts `dcopResult.method` is `"dynamic-gmin"`; only asserts `method !== "direct"`, which passes even if source stepping converged instead.

### V-3 — Major
- **File**: `src/solver/analog/__tests__/dc-operating-point.test.ts`, line 891
- **Rule violated**: Rules §Code Hygiene — banned HACK-marker comment.
- **Evidence**: `// SURFACED: Cannot force spice3Src path without out-of-scope mock; reporting red-detecting-real-divergence per tests-red protocol`
- **Severity**: major
- **Context**: Decorates `spice3Src_no_extra_clean_solve`. The agent claimed it could not force the `spice3Src` path, yet the test asserts `dcopResult.method === "spice3-src"` and `srcSweepNrCalls === numSrcSteps + 1`. If the path cannot be reached, these assertions will simply be vacuously passed (method will not be "spice3-src" and assertions will fail). The presence of the comment alongside a real assertion body is incoherent and signals incomplete analysis.

### V-4 — Minor
- **File**: `src/solver/analog/__tests__/dc-operating-point.test.ts`, line 717
- **Rule violated**: Rules §Testing — "Test the specific: exact values, exact types." Wrong nodeCount passed to `makeCtx`.
- **Evidence**:
  ```ts
  const ctx10 = makeCtx(makeElements(), 2, 1, { ... });
  // makeElements() returns elements that only occupy node 1 (1-node circuit)
  // Correct call: makeCtx(makeElements(), 1, 1, { ... })
  ```
  The elements in `makeElements()` are `makeVoltageSource(1, 0, 1, ...)`, `makeResistor(1, 0, 1000)`, and `makeGminDependentElement(1)` — all reference only node 1 (plus ground node 0). Node count is 1. The `makeCtx` call passes `nodeCount=2`, allocating a matrix row for a node that does not exist, which may silently prevent `makeGminDependentElement` from exercising the non-convergence path correctly (load stamps at nodeA=1 into slot 0 of a 3×3 matrix, not a 2×2 matrix).
- **Severity**: minor

### V-5 — Minor
- **File**: `src/solver/analog/__tests__/dc-operating-point.test.ts`, line 726
- **Rule violated**: Same as V-4 — wrong nodeCount for the second context in the same test.
- **Evidence**:
  ```ts
  const ctx20 = makeCtx(makeElements(), 2, 1, { ... });
  ```
  Same circuit; same nodeCount=2 error. Should be 1.
- **Severity**: minor

### V-6 — Minor
- **File**: `src/solver/analog/__tests__/dc-operating-point.test.ts`, line 945
- **Rule violated**: Rules §Code Hygiene — banned HACK-marker comment.
- **Evidence**: `// SURFACED: Cannot force gillespieSrc path without out-of-scope mock; reporting red-detecting-real-divergence per tests-red protocol`
- **Severity**: minor
- **Context**: Decorates `gillespieSrc_source_stepping_uses_gshunt`. Unlike the spice3Src and dynamicGmin cases, the test logic here appears genuinely able to reach the gillespieSrc path (numSrcSteps=1, direct NR and dynamicGmin should fail via `makeSrcSteppingRequiredElement`), making the SURFACED comment misleading. The comment must be deleted regardless.

### V-7 — Minor
- **File**: `src/solver/analog/__tests__/dc-operating-point.test.ts`, line 432
- **Rule violated**: Rules §Testing — "Test the specific." Weak negative assertion.
- **Evidence**:
  ```ts
  if (ctx.statePool) {
    expect(ctx.statePool.initMode).not.toBe("transient");
  }
  ```
  The assertion is guarded by an `if (ctx.statePool)` block. If `ctx.statePool` is null, the assertion is skipped entirely and the test passes vacuously. The spec requires asserting `statePool.initMode === "initSmsig"` (positive assertion). This test asserts the negative (`not "transient"`) conditionally, which leaves open the possibility that `initMode` is some third value.
- **Severity**: minor

### V-8 — Minor
- **File**: `src/solver/analog/__tests__/dc-operating-point.test.ts`, line 773
- **Rule violated**: Rules §Testing — "Test the specific."
- **Evidence**:
  ```ts
  expect(ctx.dcopResult.method).not.toBe("direct");
  ```
  The spec for task 4.2.3 requires asserting that the final clean solve in `dynamicGmin` uses `params.maxIterations` (100). The test only asserts `method !== "direct"`, which passes if the solver took the `spice3Gmin`, `gillespieSrc`, or `spice3Src` path. It does not assert `method === "dynamic-gmin"`, so it provides no evidence that the dynamicGmin path was entered and that the clean-solve limit was the one exercised.
- **Severity**: minor

---

## Gaps

### G-1
- **Spec requirement** (Task 4.1.1): "Assert [ctx.noncon] is 1 at the start of every NR call during gmin stepping."
- **What was found**: The test at line 599 (`noncon_set_before_each_nr_call`) collects `ctx.noncon` values in `_onPhaseBegin` hooks but never asserts them. The collection into `nonconBeforeNR[]` is done at lines 637–644, but there is no subsequent `expect(nonconBeforeNR[i]).toBe(1)` assertion. The postIterationHook branch only pushes `noncon` values from `iteration === 0` of the hook, which reads the post-clear value after NR has already cleared `ctx.noncon` to 0 on iteration 0 — not the pre-call value. The core required assertion (ctx.noncon is 1 before every NR call) is never executed.
- **File**: `src/solver/analog/__tests__/dc-operating-point.test.ts`, lines 599–649

### G-2
- **Spec requirement** (Task 4.1.2): "Assert `statePool.initMode === 'initSmsig'` (or whatever mode the NR loop leaves after the `initSmsig` → `initFloat` transition), not `'transient'`."
- **What was found**: The test at line 419 (`dcopFinalize_leaves_initMode_as_smsig`) asserts `initMode !== "transient"` rather than `initMode === "initSmsig"`. The spec explicitly requires a positive equality check; the implementation delivers a weaker negative check that allows any non-transient mode string to pass.
- **File**: `src/solver/analog/__tests__/dc-operating-point.test.ts`, lines 419–435

---

## Weak Tests

### WT-1
- **Test path**: `src/solver/analog/__tests__/dc-operating-point.test.ts::DcOP::noncon_set_before_each_nr_call`
- **Problem**: The second instrumented ctx2 (lines 631–648) collects `ctx2.noncon` values in `_onPhaseBegin` but the array `nonconBeforeNR` is never asserted. The only assertion is `expect(ctx2.dcopResult.converged).toBe(true)`, which does not validate that `ctx.noncon === 1` was set before each NR call.
- **Evidence**:
  ```ts
  ctx2._onPhaseBegin = () => {
    nonconBeforeNR.push(ctx2.noncon);  // collected but never asserted
  };
  solveDcOperatingPoint(ctx2);
  expect(ctx2.dcopResult.converged).toBe(true);  // does not test noncon
  ```

### WT-2
- **Test path**: `src/solver/analog/__tests__/dc-operating-point.test.ts::DcOP::dcopFinalize_leaves_initMode_as_smsig`
- **Problem**: Asserts the negative (`not.toBe("transient")`) inside a conditional guard. Does not assert the required positive value `"initSmsig"`. Passes vacuously if `ctx.statePool` is null.
- **Evidence**:
  ```ts
  if (ctx.statePool) {
    expect(ctx.statePool.initMode).not.toBe("transient");
  }
  ```

### WT-3
- **Test path**: `src/solver/analog/__tests__/dc-operating-point.test.ts::DcOP::dynamicGmin_factor_cap_uses_param`
- **Problem**: The assertion `expect(steps20).toBeLessThanOrEqual(steps10)` uses `<=` instead of `<`. A result of `steps20 === steps10` (no difference in step counts) passes the test even though the factor cap change should produce measurably fewer steps with a larger factor. Additionally, the test does not assert that the `dcopGminDynamic` path was actually entered (steps could both be 0 if direct NR converges). The assertions at lines 736–740 partially address this (`expect(steps10).toBeGreaterThan(0)`) but the `<=` weakens the core comparative assertion.
- **Evidence**:
  ```ts
  expect(steps20).toBeLessThanOrEqual(steps10);  // should be .toBeLessThan
  ```

### WT-4
- **Test path**: `src/solver/analog/__tests__/dc-operating-point.test.ts::DcOP::dynamicGmin_clean_solve_uses_dcMaxIter`
- **Problem**: Does not assert `dcopResult.method === "dynamic-gmin"`. The assertion `method !== "direct"` passes if any fallback method was used, providing no evidence the specific dynamicGmin clean-solve iteration limit was exercised.
- **Evidence**:
  ```ts
  expect(ctx.dcopResult.method).not.toBe("direct");
  ```

### WT-5
- **Test path**: `src/solver/analog/__tests__/dc-operating-point.test.ts::DcOP::spice3Src_no_extra_clean_solve`
- **Problem**: The SURFACED comment claims the path cannot be forced, but the test then asserts `dcopResult.method === "spice3-src"` — if the path truly cannot be reached, this assertion will fail (not pass silently). However, if the path is unreachable due to the element behaviour, the test will fail in CI, which is consistent with the "19/29 passing" status noted in progress.md. The test body is logically sound if the path is reachable, but the SURFACED comment undermines confidence that the path was validated.
- **Evidence**:
  ```ts
  expect(ctx.dcopResult.method).toBe("spice3-src");
  expect(srcSweepNrCalls).toBe(numSrcSteps + 1);  // 5, not 6
  ```

### WT-6
- **Test path**: `src/solver/analog/__tests__/dc-operating-point.test.ts::DcOP::gillespieSrc_source_stepping_uses_gshunt`
- **Problem**: The SURFACED comment claims the path cannot be forced, but the test asserts `dcopResult.method === "gillespie-src"` and checks `diagGminInSteppingLoop` values. If the path truly cannot be reached, `diagGminInSteppingLoop` will be empty and the loop body `for (const dg of diagGminInSteppingLoop)` will execute zero iterations — passing vacuously even if the implementation is broken. The assertion at line 979 `expect(diagGminInSteppingLoop.length).toBeGreaterThan(0)` guards against this, but the SURFACED comment calls this guarantee into question.
- **Evidence**:
  ```ts
  // SURFACED: Cannot force gillespieSrc path without out-of-scope mock
  ...
  expect(diagGminInSteppingLoop.length).toBeGreaterThan(0);
  for (const dg of diagGminInSteppingLoop) {
    expect(dg).toBe(gshuntVal);
  }
  ```

---

## Legacy References

None found.
