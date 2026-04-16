# Phase 3: Numerical Fixes

## Overview

Fix all formula bugs in ckt-terr.ts (LTE timestep estimation) and integration.ts (companion model coefficients) to match ngspice exactly. These are pure numerical corrections — no architectural changes.

**Testing surfaces:** Phase 3 is an engine-internal refactor. Per the master plan Testing Surface Policy, Phase 3 is satisfied by unit tests defined below (headless API surface) plus Phase 7 parity tests as the E2E surface. No per-phase MCP or Playwright tests are required.

**Prerequisite:** Phase 1 Task 1.2.1 has landed, which already deleted `computeIntegrationCoefficients`, introduced `ctx.gearMatScratch`, and added a `scratch: Float64Array` parameter to `solveGearVandermonde` and `computeNIcomCof`. Phase 3 does NOT re-perform that conversion; see Task 3.2.3 below for what remains.

## Wave 3.1: ckt-terr.ts Formula Fixes

### Task 3.1.1: Fix chargetol formula (Bug C1)

- **Description**: ckt-terr.ts:163 — chargetol formula is wrong. The `chgtol` must be inside the outer `max`, not inside an inner `max` with the `reltol` scaling.

  Current: `Math.max(params.reltol * Math.max(Math.abs(q0), Math.abs(q1)), params.chgtol)`
  Correct: `params.reltol * Math.max(Math.max(Math.abs(q0), Math.abs(q1)), params.chgtol)`

  ngspice reference: cktterr.c — `chargetol = MAX(fabs(qcap0), fabs(qcap1)); chargetol = reltol * MAX(chargetol, chgtol) / delta`

- **Files to modify**:
  - `src/solver/analog/ckt-terr.ts` — Fix line 163.

- **Tests**:
  - `src/solver/analog/__tests__/ckt-terr.test.ts::chargetol_includes_chgtol_in_reltol_scaling` — Call `cktTerr` with the complete input tuple: `q0=1e-16`, `q1=1e-16`, `ccap0=1e-10`, `ccap1=1e-10`, `dt=1e-9`, `abstol=1e-12`, `chgtol=1e-14`, `trtol=7`, `reltol=1e-3`, `order=1`, `method="trapezoidal"`, `deltaOld=[1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9]`. Assert the intermediate `chargetol` value (exposed via a new test-only export `__testHooks.lastChargetol`) equals `1e-17` exactly (IEEE-754 bit-identical). The old formula would produce `1e-14`. Also assert the final `cktTerr` return value matches the reference value computed from the corrected ngspice cktterr.c formula to bit-exact precision (spec author precomputes and inlines the exact Float64 reference in the test file).

- **Acceptance criteria**:
  - chargetol formula matches ngspice cktterr.c exactly.

### Task 3.1.2: Fix GEAR LTE factor selection (Bug C2)

- **Description**: ckt-terr.ts:152 — GEAR LTE factor selection uses only two values. Must use the full `GEAR_LTE_FACTORS` array indexed by `order - 1`.

  Current: `order <= 1 ? GEAR_LTE_FACTOR_0 : GEAR_LTE_FACTOR_1`
  Correct: `GEAR_LTE_FACTORS[Math.min(order - 1, GEAR_LTE_FACTORS.length - 1)]`

  ngspice reference: geardefs.h LTE factor table.

- **Files to modify**:
  - `src/solver/analog/ckt-terr.ts` — Fix line 152 in the GEAR branch.

- **Tests**:
  - `src/solver/analog/__tests__/ckt-terr.test.ts::gear_lte_factor_order_3` — Assert GEAR order 3 uses factor `3/22`, not `2/9`.
  - `src/solver/analog/__tests__/ckt-terr.test.ts::gear_lte_factor_order_6` — Assert GEAR order 6 uses factor `20/343`.

- **Acceptance criteria**:
  - GEAR LTE factors for orders 1-6 match ngspice geardefs.h exactly.

### Task 3.1.3: Fix cktTerr and cktTerrVoltage formulas (Bugs V3-V6)

- **Description**: Fix per-bug formula divergences across **both** `cktTerr` and `cktTerrVoltage` to match ngspice CKTtrunc NEWTRUNC path. Each sub-bug is tagged with its target function:

  **V3 (target: cktTerr, TRAP order 1 branch)**: TRAP order 1 must include the `deltaOld[0] * sqrt(|trtol * tol * 2 / diff|)` scaling on the ngspice `del` output. Spec author verifies exact line numbers against ngspice ckttrunc.c and the current `ckt-terr.ts::cktTerr` before implementation.

  **V4 (target: cktTerr, TRAP order 2 branch)**: TRAP order 2 must use `|deltaOld[0] * trtol * tol * 3 * (deltaOld[0]+deltaOld[1]) / diff|` formula per ngspice ckttrunc.c. Spec author verifies exact line numbers against the current `ckt-terr.ts::cktTerr`.

  **V5 (target: cktTerrVoltage, GEAR branch)**: GEAR formula must be `tmp = (tol * trtol * delsum) / (diff * delta)` where `delsum = sum(deltaOld[0..order])`, then root by `order+1`, then multiply by `delta`. Spec author verifies exact line numbers in `cktTerrVoltage`.

  **V6 (target: both cktTerr AND cktTerrVoltage, GEAR root-extraction code)**: Root index correction applies to both functions' GEAR branches:
  - GEAR order 1 must take `Math.sqrt(del)` — not return `del` directly.
  - GEAR order >= 2 must use `Math.exp(Math.log(tmp) / (order + 1))` — not `Math.exp(Math.log(del) / order)`.
  Spec author verifies exact line numbers in both functions.

  ngspice reference: ckttrunc.c NEWTRUNC code path (separate code blocks for `cktTerr` charge-based and `cktTerrVoltage` voltage-based truncation error).

- **Files to modify**:
  - `src/solver/analog/ckt-terr.ts` — Apply V3/V4 fixes to `cktTerr` TRAP branches; V5 fix to `cktTerrVoltage` GEAR branch; V6 fix to GEAR root-extraction in both functions.

- **Tests**:
  - `src/solver/analog/__tests__/ckt-terr.test.ts::cktTerr_trap_order1_matches_ngspice` (V3) — With known charge history and dt=1e-6, assert output matches ngspice to bit-exact IEEE-754 precision. Spec author precomputes reference value from ngspice formula and inlines as Float64 literal.
  - `src/solver/analog/__tests__/ckt-terr.test.ts::cktTerr_trap_order2_matches_ngspice` (V4) — Same for trap order 2 with two-deltaOld scaling term.
  - `src/solver/analog/__tests__/ckt-terr.test.ts::cktTerrVoltage_gear_order2_matches_ngspice` (V5) — Known voltage history, GEAR order 2, assert output matches ngspice bit-exact.
  - `src/solver/analog/__tests__/ckt-terr.test.ts::cktTerr_gear_order1_sqrt` and `cktTerrVoltage_gear_order1_sqrt` (V6) — Assert both functions take sqrt of del at GEAR order 1, not returning del directly.
  - `src/solver/analog/__tests__/ckt-terr.test.ts::gear_higher_order_root_is_order_plus_one` (V6) — For GEAR order 3, assert the root extraction uses `exp(log(tmp)/4)` — verify by comparing output against a reference that exercises this branch.

- **Acceptance criteria**:
  - Both `cktTerr` and `cktTerrVoltage` produce IEEE-754 identical results to ngspice CKTtrunc for all method/order combinations.

## Wave 3.2: Integration Coefficient Fixes

### Task 3.2.1: Fix NIcomCof trap order 2 rounding

- **Description**: integration.ts:434 — operand grouping differs from ngspice, causing IEEE-754 rounding divergence.

  Current: `1 / (dt * (1 - xmu))`
  Correct: `1.0 / dt / (1.0 - xmu)` — two divisions instead of one multiply + one division, matching ngspice operand order.

  ngspice reference: nicomcof.c trap order 2.

- **Files to modify**:
  - `src/solver/analog/integration.ts` — Fix line 434 in `computeNIcomCof`.

- **Tests**:
  - `src/solver/analog/__tests__/integration.test.ts::nicomcof_trap_order2_matches_ngspice_rounding` — With `dt=1.23456789e-7`, `xmu=1/3` (deliberately chosen because `1 - xmu = 2/3` is not exactly representable in IEEE-754, so operand reordering produces a measurable bit-level difference). Compute reference from ngspice formula `1.0 / dt / (1.0 - xmu)` using the same JS engine (inline in the test as Float64) to get bit-exact expected value. Assert `computeNIcomCof` trap order 2 `ag[0]` equals that reference exactly (absDelta === 0). The old code path `1 / (dt * (1 - xmu))` would produce a different last-bit value — the test explicitly computes both and asserts they differ, confirming the fix exercises the intended rounding path.

- **Acceptance criteria**:
  - `computeNIcomCof` trap order 2 ag[0] matches ngspice to IEEE-754 bit-exact.

### Task 3.2.2: Fix NIintegrate trap order 2 ccapPrev coefficient

- **Prerequisite**: Phase 1 Task 1.2.1 has landed, deleting `computeIntegrationCoefficients`. This task only touches `integrateCapacitor` and `integrateInductor`; the deleted function is no longer a concern.

- **Description**: integration.ts:53,114 — trap order 2 ccap formula uses `- ccapPrev` but should use `- ag1 * ccapPrev` where `ag1 = xmu / (1 - xmu)`. Currently only correct when xmu=0.5 (because ag1=1 when xmu=0.5).

  ngspice reference: niinteg.c trap order 2 — `ccap = ag[0] * (state0 - state1) + ag[1] * ccapPrev` where ag[1] = xmu/(1-xmu).

  Note: in `integrateCapacitor` and `integrateInductor`, the trap order 2 branch computes `ccap = (1/(dt*(1-xmu))) * (q0 - q1) - ccapPrev`. The correct formula is `ccap = ag0 * (q0 - q1) + ag1 * ccapPrev` where `ag1 = xmu/(1-xmu)` (which is negative of -ag1 term, i.e., `- (-ag1) * ccapPrev`).

- **Files to modify**:
  - `src/solver/analog/integration.ts` — Fix trap order 2 branches in `integrateCapacitor` (line 53) and `integrateInductor` (line 114). Use `ag1 = xmu / (1 - xmu)` and compute `ccap = ag0 * (q0 - q1) + ag1 * ccapPrev`.

- **Tests**:
  - `src/solver/analog/__tests__/integration.test.ts::trap_order2_ccap_with_nonstandard_xmu` — With xmu=0.3 (not 0.5), q0=1e-12, q1=0.9e-12, ccapPrev=1e-6, dt=1e-9: assert ccap matches ngspice formula. The old code gives wrong results for xmu != 0.5.

- **Acceptance criteria**:
  - Trap order 2 companion current formula matches ngspice niinteg.c for all xmu values.

### Task 3.2.3: Gear Vandermonde regression test

- **Prerequisite**: Phase 1 Task 1.2.1 has landed, which (a) added `ctx.gearMatScratch: Float64Array(49)`, (b) changed `solveGearVandermonde` to take a `scratch: Float64Array` parameter, (c) updated `computeNIcomCof` to thread the buffer through, and (d) replaced `mat[j][i]` indexing with `scratch[j * 7 + i]`. Phase 3 does NOT re-perform any of this work.

- **Description**: Add a regression test confirming the Phase 1 conversion produces numerically correct coefficients.

- **Files to modify**: None. `solveGearVandermonde` and `computeNIcomCof` already take the scratch parameter by this point.

- **Tests**:
  - `src/solver/analog/__tests__/integration.test.ts::gear_vandermonde_flat_scratch_regression` — Allocate `const scratch = new Float64Array(49)` directly in the test (independent of `CKTCircuitContext` availability). Call `computeNIcomCof(h, deltaOld, order=4, method="gear", ag, scratch)`. Assert `ag[0..4]` match pre-computed reference values for GEAR order 4 (spec author inlines exact Float64 references from the known-good nested-array implementation). Assert the scratch buffer was mutated (its first element changed from `0`), confirming it was used rather than bypassed.

- **Acceptance criteria**:
  - Zero allocations in `solveGearVandermonde` (already guaranteed by Phase 1; Phase 3 test confirms numerical correctness).
