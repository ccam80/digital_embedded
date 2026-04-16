# Spec Review: Phase 3 — Numerical Fixes

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 2 | 2 |
| major    | 0 | 5 | 5 |
| minor    | 2 | 1 | 3 |
| info     | 1 | 0 | 1 |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| Phase 3: ckt-terr.ts formula fixes | yes | Covered by Wave 3.1 (Tasks 3.1.1-3.1.3) |
| Phase 3: integration coefficient fixes | yes | Covered by Wave 3.2 (Tasks 3.2.1-3.2.3) |

The master plan names Phase 3 only as "ckt-terr formula fixes, integration coefficient fixes" with no sub-task breakdown. The spec wave/task decomposition is internally consistent with that description. No planned tasks are missing at the macro level.

---

## Findings

### Mechanical Fixes

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|------------------|
| M1 | minor | Task 3.1.3 Description -- task title and V3/V4 labels | The task title says "Fix cktTerrVoltage formulas (Bugs V3-V6)" but V3 and V4 describe TRAP path formulas that reference deltaOld[] scaling -- a path that does not exist in cktTerrVoltage at all. The TRAP branch in cktTerrVoltage is a simple two-value factor select with no deltaOld scaling. V3/V4 belong to cktTerr (the charge-based function), not cktTerrVoltage. | Retitle to "Fix cktTerr and cktTerrVoltage formulas (Bugs V3-V6)" and prefix each sub-bug with the target function: "V3 (cktTerr line N): ...", "V5 (cktTerrVoltage lines 277-296): ...", etc. |
| M2 | minor | Task 3.2.3 Files to modify | States only "integration.ts -- solveGearVandermonde takes scratch: Float64Array parameter". But solveGearVandermonde is a private function called only from computeNIcomCof. If solveGearVandermonde gains a scratch parameter, computeNIcomCof must also be updated to accept and thread the buffer. This caller update is not listed. | Add to "Files to modify": "Update computeNIcomCof signature to accept scratch: Float64Array and thread it into the solveGearVandermonde call." |

---

### Decision-Required Items

#### D1 -- Task 3.2.3 conflicts with Phase 1 Task 1.2.1 over ownership of the solveGearVandermonde scratch conversion (critical)

- **Location**: Phase 3 Task 3.2.3 Description and Files to modify; Phase 1 Task 1.2.1 Files to modify
- **Problem**: Both tasks claim to modify solveGearVandermonde in integration.ts to accept a scratch: Float64Array parameter. Phase 1 Task 1.2.1 states: "solveGearVandermonde takes a scratch: Float64Array param instead of allocating." Phase 3 Task 3.2.3 states: "solveGearVandermonde takes scratch: Float64Array parameter. Replace mat[j][i] with scratch[j * 7 + i]." Both produce tests (gear_vandermonde_uses_scratch_buffer in Phase 1, gear_vandermonde_flat_scratch in Phase 3) that verify the same post-condition. Phase 3 even acknowledges the overlap ("This is the implementation of Task 1.2.1s integration portion") but does not resolve who does the implementation work. Additionally, Phase 1 Task 1.2.1 requires deleting computeIntegrationCoefficients entirely; Phase 3 Task 3.2.3 is silent on that deletion. If Phase 3 runs before Phase 1 the function still exists; if after Phase 1, it is already gone.
- **Why decision-required**: Two phases claim implementation ownership of the same edit to the same function. Picking the wrong owner causes duplicate work, a merge conflict, or a broken Phase 3 that depends on code Phase 1 has not written yet.
- **Options**:
  - **Option A -- Phase 1 owns the scratch conversion; Phase 3 adds only the test**: Remove implementation language from Task 3.2.3 Files to modify. Replace with: "By the time Phase 3 executes, solveGearVandermonde and computeNIcomCof already accept a scratch param (Phase 1 Task 1.2.1). Phase 3 only adds gear_vandermonde_flat_scratch regression test verifying zero allocations and correct coefficients."
    - Pros: Single owner; Phase 1 delivers a complete zero-alloc function; Phase 3 adds only test coverage.
    - Cons: Phase 3 cannot be verified standalone if Phase 1 is incomplete.
  - **Option B -- Phase 3 owns the scratch conversion; Phase 1 only allocates ctx.gearMatScratch**: Remove the solveGearVandermonde modification from Phase 1 Task 1.2.1. Phase 1 only adds gearMatScratch: Float64Array(49) to CKTCircuitContext without changing the function signature. Phase 3 performs the signature change.
    - Pros: Phase 3 is self-contained for this change.
    - Cons: Phase 1 zero-alloc acceptance criterion for solveGearVandermonde cannot be verified until Phase 3 completes.
  - **Option C -- Merge Task 3.2.3 entirely into Phase 1 Task 1.2.1 and delete it from Phase 3**: Phase 1 handles everything (signature change, flat access, both tests). Phase 3 has no Task 3.2.3.
    - Pros: Single owner; cleanest boundary; Phase 3 shrinks to Tasks 3.1.x + 3.2.1 + 3.2.2.
    - Cons: Phase 3 scope changes -- requires explicit approval.

---

#### D2 -- Task 3.1.3 scope is ambiguous: which sub-bugs apply to which function? (critical)

- **Location**: Phase 3 Task 3.1.3 Description and Files to modify
- **Problem**: The task title says "Fix cktTerrVoltage formulas (Bugs V3-V6)". But inspecting the actual source:

  - cktTerrVoltage (lines 275-280) already uses GEAR_LTE_FACTORS[idx] -- no C2-equivalent bug there.
  - The TRAP branch in cktTerrVoltage (lines 275-276) is: factor = order <= 1 ? TRAP_LTE_FACTOR_0 : TRAP_LTE_FACTOR_1. There is no deltaOld[] scaling. No path matching V3/V4 formulas exists inside cktTerrVoltage.
  - Bugs V3 and V4 describe TRAP order 1/2 formulas with deltaOld[] scaling. These patterns do not exist in cktTerrVoltage. They plausibly belong to cktTerr.
  - Bug V6 says root index must be exp(log(tmp)/(order+1)) not exp(log(del)/order). Current cktTerrVoltage line 305: Math.exp(Math.log(del) / order) -- matches the V6 wrong description. But cktTerr line 186 has the identical expression. If V6 applies to both functions, the Files to modify section (listing only ckt-terr.ts, which contains both functions) is technically sufficient -- but the task title ("cktTerrVoltage") is misleading and incomplete.
  - Bug V5 describes cktTerrVoltage lines 277-296 using a formula with delsum = sum(deltaOld[0..order]). The actual cktTerrVoltage at lines 287-296 has: del = trtol * tol / denom -- no delsum variable exists. The V5 target formula does not match what is currently in the source, making it impossible to confirm fix scope without re-reading ngspice ckttrunc.c.

- **Why decision-required**: It is unclear which of V3, V4, V5, V6 applies to cktTerr, cktTerrVoltage, or both. An implementer will not know which lines in which function to change for V3, V4, and V5.
- **Options**:
  - **Option A -- Add a per-bug function-target annotation**: Rewrite the description with explicit labelling: "V3 (cktTerr only): ...", "V4 (cktTerr only): ...", "V5 (cktTerrVoltage only): ...", "V6 (both cktTerr and cktTerrVoltage): ...". Rename task to "Fix cktTerr and cktTerrVoltage formulas (Bugs V3-V6)".
    - Pros: Eliminates all ambiguity about which function each change targets.
    - Cons: Author must verify each bug target by re-reading ngspice cktterr.c and ckttrunc.c.
  - **Option B -- Split into two tasks (3.1.3a for cktTerr, 3.1.3b for cktTerrVoltage)**: Each task lists its own bugs, files, line numbers, and tests.
    - Pros: Each task is independently reviewable and executable.
    - Cons: More tasks; still requires bug-to-function assignment upfront.

---

#### D3 -- Task 3.1.1 test does not specify the full cktTerr input tuple or exact expected output (major)

- **Location**: Phase 3 Task 3.1.1 Tests
- **Problem**: The test description reads: "With q0=1e-16, q1=1e-16, chgtol=1e-14, reltol=1e-3: the old formula gives max(1e-3 * 1e-16, 1e-14) = 1e-14. The correct formula gives 1e-3 * max(1e-16, 1e-14) = 1e-3 * 1e-14 = 1e-17. Assert the corrected value."

  Two problems: (1) chargetol is not directly observable -- cktTerr returns a full timestep proposal. The spec gives q0, q1, chgtol, reltol but omits dt, abstol, trtol, ccap0, ccap1, deltaOld, order, and method -- all required to compute the return value. (2) "Assert the corrected value" gives no concrete number. An implementer cannot write expect(result).toBe(???).

- **Why decision-required**: The author must decide whether to expose the chargetol intermediate via a test helper, or to provide a complete cktTerr input tuple with a pre-computed expected return value.
- **Options**:
  - **Option A -- Provide complete input tuple and exact expected return value**: Add dt, abstol, trtol, ccap0, ccap1, deltaOld, order, method. Compute exact expected return value to 15 significant digits. Change "Assert the corrected value" to expect(result).toBeCloseTo(X, 14) where X is specified.
    - Pros: Fully specified; implementer writes the test without additional research.
    - Cons: Author must compute the reference value.
  - **Option B -- Test chargetol intermediate via exported test helper**: Export _computeChargetol(q0, q1, reltol, chgtol, dt) from ckt-terr.ts. Assert its output equals the corrected intermediate for the given inputs.
    - Pros: Directly tests the fixed sub-expression.
    - Cons: Adds a test-only export; white-box approach.

---

#### D4 -- Task 3.2.1 test "differ at bit level" is unverifiable with the given parameters (major)

- **Location**: Phase 3 Task 3.2.1 Tests
- **Problem**: The test says "With dt=1.23456789e-7, xmu=0.5: compute both formulas and assert they differ at bit level." With xmu=0.5: both 1/(dt*(1-0.5)) and 1.0/dt/(1.0-0.5) equal exactly 2/dt -- the same IEEE-754 double. The operand-reordering fix only produces a different result when xmu != 0.5. There is no bit-level difference with xmu=0.5 so the assertion cannot be satisfied as written. Furthermore, "matches ngspice" gives no reference value to assert against.

- **Why decision-required**: The test parameters produce identical results from both formula forms, making the "differ at bit level" assertion impossible to satisfy. The author must choose new parameters or redesign the test.
- **Options**:
  - **Option A -- Change xmu to a value where IEEE-754 rounding differs (e.g., xmu=1/3)**: With xmu=1/3, (1-xmu)=2/3 is not exactly representable in IEEE-754. 1/(dt*(2/3)) and 1.0/dt/(2.0/3.0) may differ at the last bit. Provide the exact expected value for the corrected formula and assert using Float64Array identity comparison.
    - Pros: Test actually exercises the rounding difference the fix targets.
    - Cons: Author must compute the exact IEEE-754 bit-level expected value.
  - **Option B -- Replace "differ at bit level" with a concrete value assertion using non-0.5 xmu**: Use xmu=0.3 and assert ag[0] equals the value of 1.0/dt/(1.0-0.3) to 15 significant digits. Remove the "differ at bit level" requirement.
    - Pros: Simpler; verifies the corrected formula is applied.
    - Cons: Does not prove the old and new formulas diverge -- only proves the new formula gives a specific result.

---

#### D5 -- Task 3.2.2 does not address computeIntegrationCoefficients trap order 2 bug or document Phase 1 dependency (major)

- **Location**: Phase 3 Task 3.2.2 Description and Acceptance criteria
- **Problem**: The description correctly identifies the (- ccapPrev) bug in integrateCapacitor (line 53) and integrateInductor (line 114). However, computeIntegrationCoefficients (integration.ts:469-500) also has a known trap order 2 bug: it returns ag1: -ag0 which is wrong -- the correct ag1 for trap order 2 is xmu/(1-xmu) = 1.0 (positive, not negative). Phase 1 Task 1.2.1 explicitly flags this: "the plan identifies ag1: -ag0 as wrong for trap order 2." Phase 1 plans to delete computeIntegrationCoefficients entirely. Phase 3 does not mention it. If Phase 3 runs before Phase 1, computeIntegrationCoefficients remains broken. If Phase 3 runs after Phase 1, the function is already gone. Neither scenario is documented in Phase 3.

  The acceptance criteria state "Trap order 2 companion current formula matches ngspice niinteg.c for all xmu values" -- but this is only verifiable for the two functions in Files to modify, not for callers of the still-broken computeIntegrationCoefficients.

- **Why decision-required**: The spec must resolve whether Task 3.2.2 should also fix computeIntegrationCoefficients, or document that this is exclusively Phase 1 responsibility and Phase 3 must run after Phase 1.
- **Options**:
  - **Option A -- Add explicit sequencing: Task 3.2.2 runs after Phase 1 Task 1.2.1**: Add a note: "Prerequisite: Phase 1 Task 1.2.1 must be complete (deletes computeIntegrationCoefficients). This task only modifies integrateCapacitor and integrateInductor."
    - Pros: Clean scope; no double-handling of the deleted function.
    - Cons: Constrains execution order; Phase 3 cannot run fully in parallel if Phase 1 is incomplete.
  - **Option B -- Include fix for computeIntegrationCoefficients trap order 2 in Task 3.2.2**: Add it to Files to modify with fix: change the trap order 2 return value from ag1: -ag0 to ag1: xmu/(1-xmu). Note Phase 1 will later delete this function.
    - Pros: Phase 3 is correct in isolation regardless of Phase 1 status.
    - Cons: Creates a temporary fix that Phase 1 will delete.

---

#### D6 -- Task 3.2.3 test references ctx.gearMatScratch but CKTCircuitContext does not yet exist (minor)

- **Location**: Phase 3 Task 3.2.3 Description -- "the scratch buffer is allocated on CKTCircuitContext"
- **Problem**: ctx.gearMatScratch comes from CKTCircuitContext (src/solver/analog/ckt-context.ts) which does not exist -- it is created by Phase 1. The test gear_vandermonde_flat_scratch must obtain a Float64Array(49) scratch buffer. If Phase 3 runs before Phase 1, there is no ctx to read from. The spec does not say how the test creates the buffer when ctx is unavailable.

- **Why decision-required**: The test implementation strategy depends on execution order, which the spec does not specify for this task.
- **Options**:
  - **Option A -- Test allocates new Float64Array(49) directly, no ctx dependency**: Change test description to: "Allocate const scratch = new Float64Array(49) directly. Call computeNIcomCof(h, deltaOld, order, method, ag, scratch) with the buffer threaded through. Assert correct ag[] values and that scratch elements were mutated."
    - Pros: Test is independent of Phase 1; can run before CKTCircuitContext exists.
    - Cons: Slightly inconsistent with production usage where scratch comes from ctx.
  - **Option B -- Make Task 3.2.3 explicitly require Phase 1 completion**: Add a note: "This task cannot be implemented until Phase 1 Task 1.2.1 is complete (provides ctx.gearMatScratch)."
    - Pros: Accurate dependency modeling.
    - Cons: Reduces Phase 3 parallelism; contradicts master plan statement that Phase 3 can run in parallel with Phase 6.

---

### Info Notes

| ID | Severity | Location | Observation |
|----|----------|----------|-------------|
| I1 | info | Task 3.1.2 Description | The spec correctly identifies the two-value GEAR factor select at cktTerr line 152 as a bug. For clarity, it should note that the analogous two-value select for the trapezoidal branch (cktTerr lines 148-149) is intentionally correct -- trapezoidal only supports orders 1 and 2, so a two-value select is complete. Without this note, an implementer may apply the same GEAR_LTE_FACTORS[idx] generalisation to the trapezoidal branch unnecessarily. |
