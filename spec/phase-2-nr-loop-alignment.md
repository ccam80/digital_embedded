# Phase 2: NR Loop Alignment (NIiter)

## Overview

Align the Newton-Raphson iteration loop with ngspice niiter.c:608-1095 exactly. Fix pnjlim/fetlim numerical bugs. Replace the multi-pass `MNAAssembler.stampAll()` with single-pass `cktLoad()` matching ngspice cktload.c.

**Testing surfaces:** Phase 2 is an engine-internal refactor. Per the master plan Testing Surface Policy, Phase 2 is satisfied by unit tests defined below (headless API surface) plus Phase 7 parity tests as the E2E surface. No per-phase MCP or Playwright tests are required.

**Prerequisite:** Phase 1 has landed. By the time Phase 2 begins, `newtonRaphson` already takes `ctx: CKTCircuitContext` and returns `void` (delivered by Phase 1 Task 1.1.2). `CKTCircuitContext` already carries `assembler`, `noncon`, `isDcOp`, `hadNodeset`, `elementsWithConvergence`, and `loadCtx` (per master plan Appendix A). All Phase 2 tasks are defined against the ctx-based signature.

## Wave 2.1: NIiter Structural Alignment

### Task 2.1.1: Rewrite pnjlim from ngspice DEVpnjlim (devsup.c:50-58)

- **Description**: Our current `pnjlim` implementation diverges from ngspice `DEVpnjlim`. Rather than enumerate individual bug fixes on the existing code, **rewrite `pnjlim` directly from ngspice devsup.c:50-58** per CLAUDE.md's "SPICE-Correct Implementations Only" rule.

  **ngspice DEVpnjlim (devsup.c:50-58):**
  ```c
  double DEVpnjlim(double vnew, double vold, double vt, double vcrit, int *icheck) {
      double arg;
      if ((vnew > vcrit) && (fabs(vnew - vold) > (vt + vt))) {
          if (vold > 0) {
              arg = 1 + (vnew - vold) / vt;
              if (arg > 0) {
                  vnew = vold + vt * log(arg);
              } else {
                  vnew = vcrit;
              }
          } else {
              vnew = vt * log(vnew / vt);
          }
          *icheck = 1;
      } else {
          *icheck = 0;
      }
      return vnew;
  }
  ```

  **Variable mapping (ngspice → ours):**
  | ngspice | ours | Notes |
  |---|---|---|
  | `vnew`, `vold` | `vnew`, `vold` | Same semantics — proposed and previous junction voltage |
  | `vt` | `vt` | Thermal voltage |
  | `vcrit` | `vcrit` | Critical voltage (≈0.6 V for silicon) |
  | `*icheck` | return tuple `{ vnew, limited }` or output param | We return a struct/tuple; `limited === true` when icheck was set to 1 |
  | `log` | `Math.log` | Natural log |

  Both the forward-bias branch (`vold > 0`) and the "cold junction" branch (`vold <= 0`) must be reproduced exactly. The forward-bias formula is `vnew = vold + vt * log(1 + (vnew - vold) / vt)` — note **no `+2` coefficient**; any historical `+2` in our code is wrong and must go.

- **Files to modify**:
  - `src/solver/analog/newton-raphson.ts` — Delete the existing `pnjlim` body; replace with a direct JavaScript port of the ngspice C code shown above.

- **Tests**:
  - `src/solver/analog/__tests__/newton-raphson.test.ts::pnjlim_matches_ngspice_forward_bias` — For vold=0.7, vnew=1.5, vt=0.02585, vcrit=0.6: assert pnjlim output equals ngspice DEVpnjlim exactly (absDelta === 0). Reference value: `arg = 1 + (1.5 - 0.7) / 0.02585`, `result = 0.7 + 0.02585 * Math.log(arg)`; `limited === true`.
  - `src/solver/analog/__tests__/newton-raphson.test.ts::pnjlim_matches_ngspice_arg_le_zero_branch` — Construct inputs where `1 + (vnew - vold)/vt <= 0` (very negative delta from positive vold). Assert `vnew === vcrit`.
  - `src/solver/analog/__tests__/newton-raphson.test.ts::pnjlim_matches_ngspice_cold_junction_branch` — For vold=-0.1 (≤0), vnew=0.5: assert `vnew = vt * Math.log(vnew / vt)` and `limited === true`.
  - `src/solver/analog/__tests__/newton-raphson.test.ts::pnjlim_no_limiting_when_below_vcrit` — For vnew=0.3 (< vcrit=0.6): assert output equals input `vnew` and `limited === false`.

- **Acceptance criteria**:
  - `pnjlim` is a direct port of ngspice devsup.c:50-58; variable-mapping table is included as a comment in the source.
  - Bit-exact IEEE-754 match vs. ngspice DEVpnjlim for all test vectors.

### Task 2.1.2: Fix fetlim formula bug

- **Description**: Bug in `fetlim` (newton-raphson.ts:341): `const vtstlo = Math.abs(vold - vto) + 1` should be `const vtstlo = vtsthi / 2 + 2` matching ngspice DEVfetlim exactly.

  ngspice reference: devsup.c DEVfetlim.

- **Files to modify**:
  - `src/solver/analog/newton-raphson.ts` — Fix line 341.

- **Tests**:
  - `src/solver/analog/__tests__/newton-raphson.test.ts::fetlim_matches_ngspice_deep_on` — For vold=5.0, vnew=8.0, vto=1.0: assert fetlim output matches ngspice. `vtsthi = abs(2*(5-1))+2 = 10`, `vtstlo = 10/2+2 = 7`. Since delv=3 < vtsthi=10, vnew=8.0 (unchanged).
  - `src/solver/analog/__tests__/newton-raphson.test.ts::fetlim_matches_ngspice_off_region` — For vold=-1.0, vnew=3.0, vto=1.0: assert fetlim output matches ngspice for the OFF→ON transition.

- **Acceptance criteria**:
  - `fetlim` produces IEEE-754 identical results to ngspice DEVfetlim for all test vectors.

### Task 2.1.3: Add hadNodeset gate on ipass logic

- **Description**: The INITF dispatcher's ipass logic (newton-raphson.ts:665-679) must be gated on `ctx.hadNodeset` matching ngspice niiter.c:1051-1052. The ipass decrement (which forces one extra NR iteration after initFix→initFloat transition) only fires when the circuit has nodesets. `ctx.hadNodeset` is derived from `ctx.nodesets.size > 0` at context construction time.

  ngspice reference: niiter.c:1050-1060 — `if(ckt->CKThadNodeset)` gates the ipass check.

- **Files to modify**:
  - `src/solver/analog/ckt-context.ts` — Add `hadNodeset: boolean` field, set from `nodesets.size > 0` in constructor (already listed in Appendix A but formalized here).
  - `src/solver/analog/newton-raphson.ts` — Gate the ipass logic in the INITF dispatcher with `if (ctx.isDcOp && ctx.hadNodeset)`. Both operands read from `ctx` (the ctx-based `newtonRaphson` signature is already in place after Phase 1).

- **Tests**:
  - `src/solver/analog/__tests__/newton-raphson.test.ts::ipass_skipped_without_nodesets` — Run NR with dcopModeLadder on a circuit with no nodesets. Assert that after initFix→initFloat transition, convergence returns immediately on noncon===0 (no extra ipass iteration).
  - `src/solver/analog/__tests__/newton-raphson.test.ts::ipass_fires_with_nodesets` — Run NR with dcopModeLadder on a circuit with nodesets. Assert that after initFix→initFloat, one extra iteration runs before convergence return.

- **Acceptance criteria**:
  - ipass logic only fires when `ctx.hadNodeset === true`, matching ngspice.

## Wave 2.2: CKTload Single-Pass (replaces MNAAssembler.stampAll)

### Task 2.2.1: Implement cktLoad function

- **Description**: Create the `cktLoad(ctx, iteration)` function matching ngspice cktload.c:29-158. This replaces `MNAAssembler.stampAll()`. The function:
  1. Clears matrix and RHS: `solver.beginAssembly(matrixSize)`
  2. Updates `ctx.loadCtx` fields for this iteration
  3. Single device loop: `for each element: element.load(ctx.loadCtx)`
  4. Applies nodesets/ICs after device loads (only in DC mode during initJct/initFix)
  5. Finalizes matrix: `solver.finalize()`

  No separate `updateOperatingPoint`, `stampNonlinear`, or `stampReactiveCompanion` passes. One call to `element.load()` per device per iteration.

  This task depends on Phase 6 (all elements implementing `load()`). The function is defined here but only wired in when Phase 6 completes.

- **Files to create**:
  - `src/solver/analog/ckt-load.ts` — `cktLoad(ctx: CKTCircuitContext, iteration: number): void` function matching master plan **Appendix B: cktLoad Function Pseudocode** (`spec/ngspice-alignment-master.md`), which mirrors ngspice cktload.c:29-158.

- **Files to modify**:
  - `src/solver/analog/newton-raphson.ts` — Replace `assembler.stampAll(...)` call with `cktLoad(ctx, iteration)`.

- **Tests**:
  - `src/solver/analog/__tests__/ckt-load.test.ts::single_pass_stamps_all_contributions` — Create a circuit with resistor + capacitor + diode. Call `cktLoad` once. Assert the solver matrix contains all stamps (linear + nonlinear + reactive companion) from a single pass.
  - `src/solver/analog/__tests__/ckt-load.test.ts::nodesets_applied_after_device_loads` — Create a circuit with nodesets. Assert that nodeset stamps appear in the matrix after `cktLoad` in initJct mode. Assert they do NOT appear in initFloat mode.
  - `src/solver/analog/__tests__/ckt-load.test.ts::noncon_incremented_by_device_limiting` — Create a circuit with a diode. Run `cktLoad` at iteration > 0 with a voltage that triggers pnjlim. Assert `ctx.noncon > 0`.

- **Acceptance criteria**:
  - `MNAAssembler` class deleted from codebase.
  - `mna-assembler.ts` file deleted.
  - Single `cktLoad()` call replaces the old multi-pass stamp sequence.
  - Nodesets/ICs applied inside cktLoad, not as a separate step.

### Task 2.2.2: Delete MNAAssembler

- **Description**: Remove `MNAAssembler` class and `mna-assembler.ts` file. All functionality absorbed into `cktLoad()` and `CKTCircuitContext`. The `checkAllConverged` and `checkAllConvergedDetailed` methods move to standalone functions or inline into the NR convergence check using `ctx.elementsWithConvergence`.

- **Files to delete**:
  - `src/solver/analog/mna-assembler.ts`

- **Files to modify**:
  - `src/solver/analog/newton-raphson.ts` — Remove `import { MNAAssembler }`. Replace `assembler.noncon` with `ctx.noncon`. Replace `assembler.checkAllConverged(...)` with inline loop over `ctx.elementsWithConvergence`. Also remove the `assembler` field from `CKTCircuitContext` (deletion of temporary bridge introduced in Phase 1).

- **Files to delete or migrate**:
  - `src/solver/analog/__tests__/mna-assembler.test.ts` — Migrate **all end-to-end NR-convergence tests** (tests that compile a circuit, run NR, and assert on final node voltages or convergence state) into `src/solver/analog/__tests__/ckt-load.test.ts`, preserving their assertions and reference values verbatim. **Delete class-internal tests** (tests that exercise `MNAAssembler` constructor, the `noncon` field, or other internal methods without running a full NR convergence) without replacement — those code paths no longer exist. After migration/deletion, delete `mna-assembler.test.ts` entirely.

- **Tests**:
  - Every migrated end-to-end NR test must pass at its original assertion values against the new `cktLoad` path.

- **Acceptance criteria**:
  - `mna-assembler.ts` does not exist.
  - `mna-assembler.test.ts` does not exist.
  - No imports of `MNAAssembler` anywhere in the codebase.
  - `CKTCircuitContext.assembler` field removed.
  - All convergence checking uses `ctx.elementsWithConvergence` inline loop.

### Task 2.2.3: Verify E_SINGULAR continue-to-cktLoad behaviour against the new cktLoad function

- **Description**: Phase 0 Task 0.3.2 restructured the NR E_SINGULAR handler to `continue` back to the top of the loop (re-executing the load sequence + factor). Phase 0 tested this via the observable-effect pattern (`lastFactorUsedReorder === true` on recovery). This task verifies that the same behaviour holds after `cktLoad` replaces `stampAll` — no code change is required, only a regression test using the new load function.

  ngspice reference: niiter.c:888-891.

- **Files to modify**: None (verification-only task).

- **Tests**:
  - `src/solver/analog/__tests__/ckt-load.test.ts::e_singular_recovery_via_cktLoad` — Build a mock circuit where the first `factor()` in the NR loop fails with E_SINGULAR on the numeric-only path but converges after `cktLoad` re-runs + reorder. Assert the NR loop reaches convergence with the correct solution, `solver.lastFactorUsedReorder === true` on the recovery iteration, and the expected total NR iteration count. This directly exercises the Phase 0 control-flow change against the Phase 2 `cktLoad`.

- **Acceptance criteria**:
  - The Phase 0 E_SINGULAR continue-to-load behaviour is preserved after `cktLoad` replaces `stampAll`.
