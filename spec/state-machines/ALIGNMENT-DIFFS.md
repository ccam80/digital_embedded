# ngspice Alignment Diff Report — Consolidated

Generated from 5 parallel architect reviews of `ngspice.yaml` vs `ours.yaml`.
128 raw diffs deduplicated to 68 unique actionable items.

**Ground rule:** Every difference is a defect in our engine. ngspice is the reference.
No difference is "intentional", "architectural", "pragmatic", or "known".

---

## Category 1: NR Loop Structure (CRITICAL)

These diffs change the fundamental iteration ordering inside Newton-Raphson.

### 1.1 Iteration limit checked AFTER convergence instead of BEFORE
**Sources:** DIFF-NR-03, DIFF-DCOP-19, DIFF-DCOP-20, DIFF-TRAN-23
**ngspice:** `check_iteration_limit` (L629) fires IMMEDIATELY after `sparse_solve`, BEFORE convergence. If `iterno > maxIter`, return `E_ITERLIM` — no convergence check, no damping, no INITF.
**ours:** Iteration limit is checked LAST, inside `nr_check_can_converge` (L1029). All convergence checks, damping, mode transitions, blame tracking run first.
**Fix:** Add `nr_check_iteration_limit` state immediately after `nr_sparse_solve`. If exceeded, return failure. Remove limit from `nr_check_can_converge`.

### 1.2 Operating point update is post-solve; should be pre-factor (CKTload unification)
**Sources:** DIFF-NR-05, DIFF-MTX-06, DIFF-MTX-15, DIFF-MTX-11, DIFF-MTX-09
**ngspice:** Single `CKTload` state at loop top: zeros matrix, evaluates ALL devices (linear + nonlinear + reactive), stamps everything. Then factor, then solve.
**ours:** Stamps (linear hoisted, nonlinear, reactive) at loop top -> factor -> solve -> `updateOperatingPoints` post-solve. Device evaluation is split across loop boundary.
**Fix:** Replace 7 linear-hoisting states + separate stamp states with a single `nr_clear_and_load` state that zeros matrix and calls all stamps every iteration. Move device evaluation to pre-factor position. This subsumes the linear-hoisting removal.

### 1.3 INITF dispatcher split into two separate state machines
**Sources:** DIFF-NR-10, DIFF-NR-11, DIFF-NR-12, DIFF-DCOP-10
**ngspice:** Single `check_initf_and_transition` dispatcher (L694) handles ALL 6 INITF transitions, positioned AFTER damping.
**ours:** Two dispatchers: `nr_transient_mode_automaton` (before damping) and `nr_dcop_mode_ladder_transition` (after convergence checks). Different positions, different mechanisms.
**Fix:** Merge into single `nr_check_initf_and_transition` state after damping. Handle initJct, initFix, initFloat, initTran, initPred, initSmsig in one place.

### 1.4 Missing RHS vector swap state
**Sources:** DIFF-NR-04, DIFF-MTX-07
**ngspice:** `swap_rhs_vectors` (L812) swaps CKTrhsOld/CKTrhs pointers (O(1)) at loop bottom. Devices read from CKTrhsOld (previous iteration).
**ours:** `prevVoltages.set(voltages)` copies (O(n)) at loop top. Devices read from `voltages` which contains NEW solution post-solve.
**Fix:** Add `nr_swap_solution_vectors` at loop bottom. Switch to pointer swap. Verify device evaluation reads from "old" voltages.

### 1.5 Missing explicit noncon=0 reset at loop top
**Sources:** DIFF-NR-18, DIFF-MTX-09
**ngspice:** `clear_noncon_and_load` (L461) sets `CKTnoncon = 0` + resets limit collector BEFORE device load.
**ours:** noncon reset embedded inside `updateOperatingPoints`, not at a separate loop-top step.
**Fix:** Add explicit `noncon = 0` + limit reset as first action in the NR loop iteration body.

### 1.6 Convergence return and INITF transitions interleaved incorrectly
**Sources:** DIFF-NR-12, DIFF-NR-21
**ngspice:** Convergence return (`MODEINITFLOAT && noncon==0 -> return OK`) is INSIDE the INITF dispatcher, with ipass guard.
**ours:** Convergence return is in separate `nr_check_can_converge` state AFTER the INITF transitions.
**Fix:** Fold convergence-gated return into the unified INITF dispatcher (item 1.3).

---

## Category 2: CKTop Wrapper + DCOP Finalization (HIGH)

### 2.1 Missing CKTop wrapper layer
**Sources:** DIFF-DCOP-01, DIFF-DCOP-02, DIFF-DCOP-03
**ngspice:** `cktop_initial_solve` -> `cktop_converged` / `cktop_failed` wraps all convergence aids. Has `CKTnoOpIter` bypass.
**ours:** No wrapper. DCOP goes directly to NR -> gmin -> source stepping without indirection.
**Fix:** Add `cktop_initial_solve`, `cktop_converged`, `cktop_failed` states. Add `CKTnoOpIter` parameter.

### 2.2 Missing DCOP finalization (4 states)
**Sources:** DIFF-DCOP-04, DIFF-DCOP-05, DIFF-DCOP-06, DIFF-DCOP-07, DIFF-NR-15, DIFF-TRAN-25, DIFF-DEVICE-04
**ngspice:** `dcop_finalize` -> `dcop_set_smsig_mode` -> `dcop_final_load` -> `dcop_output` extracts small-signal parameters, outputs results, runs SOA check.
**ours:** Returns directly from `dcop_return_success`. No MODEINITSMSIG pass.
**Fix:** Add all 4 finalization states. Add `initSmsig` mode. Required for AC analysis correctness.

### 2.3 Missing MODEINITSMSIG mode and transition
**Sources:** DIFF-DCOP-05, DIFF-DCOP-09, DIFF-NR-14, DIFF-DEVICE-04
**ngspice:** `MODEINITSMSIG` is the 6th INITF mode. Used in DCOP finalization. Transition: `smsig -> float`.
**ours:** Only 5 modes: initJct, initFix, initFloat, initTran, initPred.
**Fix:** Add `initSmsig` to initMode enum. Add transition in unified INITF dispatcher.

### 2.4 Premature mode reset after DCOP convergence
**Sources:** DIFF-DCOP-26
**ngspice:** Mode stays as-is through finalization sequence. Only set to transient AFTER finalization.
**ours:** `dcop_direct_check_converged` resets `pool.initMode` to transient immediately.
**Fix:** Do NOT reset initMode at convergence. Reset only after finalization is complete.

### 2.5 Missing CKTncDump in DCOP failure
**Sources:** DIFF-DCOP-08
**ngspice:** `dcop_failed` calls `CKTncDump` — detailed per-node/device non-convergence report.
**ours:** Returns `{converged: false}` with generic diagnostic.
**Fix:** Add CKTncDump-equivalent diagnostics showing which nodes/devices caused non-convergence.

### 2.6 Missing separate transient DCOP entry
**Sources:** DIFF-DCOP-25, DIFF-TRAN-15
**ngspice:** `tran_dcop_entry` calls CKTop with `MODETRANOP|MODEINITJCT` flags.
**ours:** Reuses `dcop_begin` for all DCOP calls. No MODETRANOP distinction.
**Fix:** Add `MODETRANOP` mode flag. Route transient DCOP through CKTop with correct mode bits.

---

## Category 3: Matrix Factorization + Solver (CRITICAL)

### 3.1 Missing dual factorization paths
**Sources:** DIFF-MTX-01, DIFF-NR-08, DIFF-DCOP-17
**ngspice:** Two paths: `lu_factorize_with_reorder` (Markowitz) and `lu_factorize_numerical` (reuse pivots). Selected by `NISHOULDREORDER` flag.
**ours:** Single `nr_lu_factorize` — always full LU with partial pivoting. No pivot reuse.
**Fix:** Split into two paths. Add `shouldReorder` flag. Numerical-only path must reuse `pinv[]/q[]` without pivot search.

### 3.2 Missing singular matrix retry
**Sources:** DIFF-MTX-02, DIFF-MTX-05, DIFF-NR-09, DIFF-TRAN-26, DIFF-DEVICE-03
**ngspice:** E_SINGULAR from numerical factorization -> set NISHOULDREORDER -> loop back to `clear_noncon_and_load` for retry with full reorder.
**ours:** Singular -> `nr_singular_matrix_abort` -> `nr_return_failure`. No retry.
**Fix:** On singular from numerical path: set shouldReorder, loop back to NR top. Only abort from reorder path (truly singular).

### 3.3 Missing preorder step
**Sources:** DIFF-MTX-03, DIFF-NR-07, DIFF-DCOP-18
**ngspice:** `preorder_matrix` — one-time column/row permutation via SMPpreOrder. Gated by `NIDIDPREORDER`.
**ours:** AMD ordering inside `nr_finalize_matrix`. No separate preorder.
**Fix:** Add `nr_preorder_matrix` state with `didPreorder` flag. This also serves as the branch point for dual factorization.

### 3.4 Markowitz vs AMD ordering
**Sources:** DIFF-MTX-04
**ngspice:** Markowitz pivot selection during factorization (interleaved with elimination).
**ours:** AMD as a separate preprocessing step.
**Fix:** Implement Markowitz in the full-reorder path. AMD acceptable for the numerical-only path as fill-reducing pre-order.

### 3.5 diagGmin application timing
**Sources:** DIFF-MTX-10
**ngspice:** gmin applied INSIDE `spOrderAndFactor` — affects Markowitz pivot selection.
**ours:** gmin applied as separate `nr_add_diagonal_gmin` step BEFORE factorization.
**Fix:** For reorder path: integrate gmin into Markowitz factorization. For numerical path: separate pre-step is acceptable.

### 3.6 Linear stamp hoisting — unproven correctness
**Sources:** DIFF-MTX-06, DIFF-NR-05
**ngspice:** CKTload zeros and re-stamps EVERYTHING every iteration. No separation.
**ours:** 7 states for linear stamp hoisting (stamp once, save, restore, re-stamp nonlinear only).
**Fix:** Remove hoisting and re-stamp everything every iteration, OR provide formal proof that stampLinear output is iteration-invariant for ALL element types. Until proof exists, this is a correctness defect.

---

## Category 4: INITF Guard Conditions (HIGH)

### 4.1 FIX->FLOAT guard: extra `ladderModeIter > 0` condition
**Sources:** DIFF-DCOP-12, DIFF-NR-13
**ngspice:** Transition on `CKTnoncon == 0` alone. Uses `ipass` counter for hadNodeset extra pass.
**ours:** Transition on `noncon == 0 AND ladderModeIter > 0`. No ipass/hadNodeset.
**Fix:** Remove `ladderModeIter > 0` guard. Add `ipass` counter. On FIX->FLOAT: set `ipass=1`. In FLOAT convergence: if `ipass != 0`, force extra iteration.

### 4.2 TRAN->FLOAT guard too restrictive + unconditional reorder
**Sources:** DIFF-DCOP-13, DIFF-NR-22
**ngspice:** Unconditional transition. Conditional reorder: only when `iterno <= 1`.
**ours:** Only at `iteration == 0`. Always reorders.
**Fix:** Make transition unconditional. Make reorder conditional on `iteration <= 0`.

### 4.3 Newton damping guard conditions differ
**Sources:** DIFF-DCOP-23, DIFF-NR-20
**ngspice:** `CKTnodeDamping && noncon!=0 && (MODETRANOP || MODEDCOP) && iterno > 1`. Damps voltages AND state0.
**ours:** `nodeDamping && noncon!=0 && isDcOp && iter > 0`. Missing MODETRANOP.
**Note on iteration guard:** ngspice increments `iterno` inside CKTload (before the check), so `iterno > 1` fires from the second CKTload pass onward. Our `iteration > 0` fires from the second for-loop pass onward. These are equivalent — do NOT change the iteration guard.
**Fix:** Add MODETRANOP to guard (verify `isDcOp` covers transient OP mode; if not, expand). Ensure state0 damping is applied (not just voltage damping).

### 4.4 maxIter >= 100 floor
**Sources:** DIFF-DCOP-24, DIFF-NR-23, DIFF-PARAM-08
**ngspice:** NIiter floors maxIter to 100. Transient with CKTtranMaxIter=10 gets 100 iterations.
**ours:** Has floor via `Math.max(rawMaxIter, 100)` but `exactMaxIterations` flag can bypass it.
**Fix:** Verify no transient caller sets `exactMaxIterations: true`. Remove or restrict the bypass.

---

## Category 5: Transient Loop Architecture (CRITICAL)

### 5.1 State rotation timing: acceptance vs before-retry
**Sources:** DIFF-TRAN-01, DIFF-TIMESTEP-03
**ngspice:** State vectors rotated (pointer swap) at TOP of outer time loop, BEFORE retry. On retry, only `CKTtime -= CKTdelta`. No state restoration.
**ours:** State pool rotated (data copy) at ACCEPTANCE time, AFTER retry. On retry, state0 explicitly restored from state1.
**Fix:** Move rotation to before retry loop. Change to pointer swap. Remove `transient_restore_state0_from_state1`. On retry, only restore time.

### 5.2 Missing CKTaccept per-device callback
**Sources:** DIFF-TRAN-02, DIFF-DEVICE-01
**ngspice:** `CKTaccept(ckt)` iterates all devices calling `DEVaccept`. Also rotates predictor ring and clears breakpoints.
**ours:** No per-device acceptance callback.
**Fix:** Add `transient_call_device_accept` state. Add `deviceAccept()` to element interface.

### 5.3 Missing centralized NIcomCof (integration coefficients)
**Sources:** DIFF-TRAN-09, DIFF-INTEG-01, DIFF-INTEG-02
**ngspice:** `NIcomCof(ckt)` computes `CKTag[0..order]` centrally ONCE per timestep. All devices read shared coefficients.
**ours:** Each element computes `ag0 = 1/dt` locally. No centralized `CKTag[]`.
**Fix:** Add `transient_compute_integration_coefficients` state. Centralize ag[] computation. Elements read from shared store. Required for trap-2 (`ag[0] = 1/(dt*(1-xmu))`) and Gear correctness.

### 5.4 LTE order promotion timing: after acceptance vs inside LTE check
**Sources:** DIFF-TRAN-19
**ngspice:** Order promotion trial runs INSIDE `tran_truncation_error_check`, BEFORE accept/reject decision. Affects current step.
**ours:** Order promotion runs AFTER acceptance. Only affects next step.
**Fix:** Move `tryOrderPromotion()` into the LTE check, before the accept/reject decision.

### 5.5 Missing explicit end-time check
**Sources:** DIFF-TRAN-03
**ngspice:** `|CKTtime - CKTfinalTime| < CKTminBreak` check after output.
**ours:** No end-time check (streaming).
**Fix:** Add `transient_check_end_time` state. When tStop is configured, check proximity and terminate.

### 5.6 Missing explicit output data state
**Sources:** DIFF-TRAN-04
**ngspice:** `CKTdump(ckt, CKTtime, plot)` gated by `CKTtime >= CKTinitTime`.
**ours:** Output via observers, no CKTinitTime gate.
**Fix:** Add `transient_output_data` state with CKTinitTime gate.

### 5.7 State copy after DCOP at wrong location
**Sources:** DIFF-TRAN-16
**ngspice:** `state0 -> state1` copy happens AFTER ag[] zeroing and mode transition.
**ours:** Copy happens BEFORE analysisMode transition.
**Fix:** Reorder: (1) set analysisMode=tran, (2) zero ag[], (3) state0->state1 copy.

### 5.8 Missing ag[] zeroing at DCOP-to-transient transition
**Sources:** DIFF-TRAN-13
**ngspice:** Explicitly sets `CKTag[0] = CKTag[1] = 0` when transitioning.
**ours:** Relies on each element checking `dt > 0` — fragile.
**Fix:** Centralized ag[] zeroing at mode transition (subsumes per-element guards).

---

## Category 6: Timestep Control (HIGH)

### 6.1 Initial delta formula uses wrong input
**Sources:** DIFF-TRAN-06, DIFF-TIMESTEP-01
**ngspice:** `delta = MIN(finalTime/100, CKTstep) / 10`. Uses output step.
**ours:** Uses `maxTimeStep` where ngspice uses `CKTstep`.
**Fix:** Add `tStep` parameter. Use `MIN(tStop/100, tStep) / 10`.

### 6.2 delmin computed differently (10x too large)
**Sources:** DIFF-TRAN-07, DIFF-PARAM-10
**ngspice:** `CKTdelmin = 1e-11 * CKTmaxStep` (computed).
**ours:** Fixed `1e-15`. For maxStep=10e-6: ngspice=1e-16, ours=1e-15.
**Fix:** Change to computed: `minTimeStep = 1e-11 * maxTimeStep`.

### 6.3 Breakpoint epsilon 6 orders of magnitude too small
**Sources:** DIFF-TRAN-08, DIFF-TIMESTEP-02
**ngspice:** `CKTminBreak = CKTmaxStep * 5e-5`. For maxStep=10e-6: 5e-10.
**ours:** `minTimeStep * 0.5`. For minTimeStep=1e-15: 5e-16.
**Fix:** Change to `maxTimeStep * 5e-5`. Current value effectively disables breakpoint deduplication.

### 6.4 Missing CKTbreak flag
**Sources:** DIFF-TRAN-21
**ngspice:** `CKTbreak` flag set when stepping to a breakpoint. Devices can read it.
**ours:** No equivalent flag.
**Fix:** Add `CKTbreak` boolean to TimestepController. Set when clamping dt to breakpoint.

### 6.5 Firsttime /10 is conditional instead of unconditional
**Sources:** DIFF-TRAN-06
**ngspice:** Unconditional `/= 10` on firsttime.
**ours:** Only when breakpoints exist.
**Fix:** Make unconditional.

---

## Category 7: Missing UIC + Nodeset Support (HIGH)

### 7.1 Missing UIC single-load bypass
**Sources:** DIFF-NR-01, DIFF-NR-02, DIFF-DCOP-16, DIFF-TRAN-22, DIFF-DEVICE-05
**ngspice:** `MODETRANOP && MODEUIC` -> single CKTload -> return OK. No NR iteration.
**ours:** `uic` parameter exists but no bypass path in NR loop.
**Fix:** Add `nr_check_uic_bypass` and `nr_uic_single_load` at NR entry.

### 7.2 Missing nodeset/IC 1e10 conductance enforcement
**Sources:** DIFF-NR-06, DIFF-DCOP-15, DIFF-TRAN-12, DIFF-DEVICE-06
**ngspice:** `apply_nodesets_and_ics` stamps 1e10 conductance for nodeset/IC nodes during MODEDC.
**ours:** Element-level initFix handling only. No 1e10 conductance stamps.
**Fix:** Add `nr_apply_nodesets_and_ics` state after device load, before factorization.

---

## Category 8: Missing Parameters (MEDIUM-HIGH)

### 8.1 Completely missing parameters (6)
**Sources:** DIFF-PARAM-05, DIFF-PARAM-12, DIFF-PARAM-14, DIFF-PARAM-16, DIFF-PARAM-20, DIFF-PARAM-21

| Parameter | ngspice name | Value | Role |
|-----------|-------------|-------|------|
| diagGmin | CKTdiagGmin | 0.0 | Active diagonal gmin during stepping (persistent, not local) |
| step | CKTstep | 0.0 | Requested output timestep (for initial delta formula) |
| initTime | CKTinitTime | 0.0 | Start time for data output (skip initial transient) |
| maxOrder | CKTmaxOrder | 2 | Maximum integration order |
| lteReltol | CKTlteReltol | 1e-3 | NEWTRUNC voltage-based LTE relative tolerance |
| lteAbstol | CKTlteAbstol | 1e-6 | NEWTRUNC voltage-based LTE absolute tolerance |

### 8.2 Hardcoded values that should be parameters (3)
**Sources:** DIFF-PARAM-26, DIFF-PARAM-27, DIFF-PARAM-29

| Parameter | Value | Location |
|-----------|-------|----------|
| gminFactor | 10.0 | dc-operating-point.ts:462,598 |
| srcFact | 1.0 | dc-operating-point.ts:676 (should be persistent state) |
| xmu | 0.5 | behavioral-remaining.ts:661, integration.ts:41 |

### 8.3 Naming inversions causing cross-reference confusion
**Sources:** DIFF-PARAM-02, DIFF-PARAM-03

| ngspice | Our name | Problem |
|---------|----------|---------|
| CKTvoltTol (voltage) | abstol | Collides with ngspice CKTabstol (current) |
| CKTabstol (current) | iabstol | Unclear naming |

**Fix:** Rename `abstol` -> `voltTol`, `iabstol` -> `abstol` (or add explicit mapping).

### 8.4 gshunt not in defaults
**Sources:** DIFF-PARAM-06
**Fix:** Add `gshunt: 0` to `DEFAULT_SIMULATION_PARAMS`.

---

## Category 9: Missing Capabilities (MEDIUM)

### 9.1 Missing NEWTRUNC voltage-based LTE
**Sources:** DIFF-LTE-01, DIFF-PARAM-20, DIFF-PARAM-21
**ngspice:** Voltage-domain LTE with `lteReltol`/`lteAbstol`. Standard in modern ngspice.
**ours:** Only charge-based CKTterr.
**Fix:** Implement voltage-based divided differences in `ckt-terr.ts`.

### 9.2 Missing GEAR integration method
**Sources:** DIFF-PARAM-17, DIFF-LTE-02, DIFF-TIMESTEP-04
**ngspice:** GEAR orders 1-6.
**ours:** Only BDF-1 (=Gear-1), trapezoidal, BDF-2 (=Gear-2). No GEAR orders 3-6.
**Fix:** Implement GEAR 3-6 in integration.ts. Expand state arrays to 8 (item 5.9).

### 9.3 State arrays: 4 vs 8
**Sources:** DIFF-TRAN-10, DIFF-TIMESTEP-04
**Fix:** Expand StatePool from 4 to 8 arrays. Required for GEAR support.

### 9.4 Missing device bypass check
**Sources:** DIFF-DEVICE-02
**ngspice:** `DEVbypass` skips re-evaluation when voltages unchanged.
**ours:** Not implemented.
**Fix:** Add `shouldBypass()` to element interface.

---

## Category 10: Gmin/Source Stepping Details (MEDIUM)

### 10.1 Final clean solve uses diagGmin=0 instead of gshunt
**Sources:** DIFF-DCOP-28
**Fix:** Use `diagGmin = gshunt` (not 0) in `dcop_gmin_final_clean_solve`.

### 10.2 Missing gmin sub-bootstrap in source stepping
**Sources:** DIFF-DCOP-29
**ngspice:** On zero-source solve failure, tries gmin stepping within source stepping.
**ours:** No gmin sub-bootstrap. Failed zero-source -> direct failure.
**Fix:** Add gmin sub-bootstrap path.

### 10.3 Missing srcFact=1 reset on source stepping exit
**Sources:** DIFF-DCOP-30
**Fix:** Ensure `srcFact = 1` on all exits from source stepping.

### 10.4 Initial diagGmin value may differ
**Sources:** DIFF-DCOP-31
**ngspice:** Starts CKTdiagGmin at 1e-2 for first sub-solve.
**ours:** Starts at 1e-3 (one factor lower).
**Fix:** Verify and align initial value to 1e-2.

### 10.5 Final clean solve maxIter mismatch
**Sources:** DIFF-DCOP-32
**ngspice:** Uses dcTrcvMaxIter (50) for final clean solve.
**ours:** Uses maxIterations (100).
**Fix:** Use dcTrcvMaxIter for all gmin stepping sub-solves including final.

### 10.6 Missing OldRhsOld + OldCKTstate0 save/restore in gmin stepping
**Sources:** DIFF-DCOP-27
**Fix:** Verify snapshot includes both voltage vector AND state0. If not, add state0 to snapshot.

---

## Category 11: Predictor (LOW-MEDIUM)

### 11.1 Predictor default off vs typically compiled in
**Sources:** DIFF-PARAM-30, DIFF-PRED-02, DIFF-TRAN-18
**Fix:** Change `predictor` default from `false` to `true`.

### 11.2 Predictor agp computation separate from ag computation
**Sources:** DIFF-PRED-01
**Fix:** When centralizing ag[] (item 5.3), fold agp into the same centralized function.

---

## Category 12: Extra States in Ours (Evaluate for Removal)

### 12.1 Linear circuit short-circuit
**Sources:** DIFF-NR-25
**ours:** `nr_linear_shortcircuit` returns immediately for linear-only circuits. Bypasses convergence, damping, INITF.
**ngspice:** No special case. Full NR loop for all circuits.
**Fix:** Remove or prove behavioral equivalence.

### 12.2 Blame tracking + post-iteration hook in NR critical path
**Sources:** DIFF-NR-24
**ours:** `nr_blame_tracking` and `nr_post_iteration_hook` between convergence and return.
**ngspice:** No equivalent instrumentation in NR loop.
**Fix:** Move to side-effect position. Must not affect control flow ordering.

### 12.3 Extra pivot-threshold retry in factor()
**Sources:** DIFF-MTX-14
**ours:** Retry with topology rebuild when pivot threshold fails (not singular).
**ngspice:** No equivalent.
**Fix:** Document. May be subsumed by Markowitz implementation.

---

## Category 13: Minor / Verified Equivalent

### 13.1 No change needed
- Iteration counter 0-based vs 1-based — consistently handled (DIFF-MTX-12)
- NR failure dt /= 8 — matches (DIFF-TRAN-17)
- LTE 2x growth cap — matches (DIFF-TRAN-24)
- Pivot thresholds — match (DIFF-PARAM-22, DIFF-PARAM-23)
- trtol=7.0 — matches (DIFF-PARAM-18)
- chargeTol=1e-14 — matches (DIFF-PARAM-19)
- gmin=1e-12 — matches (DIFF-PARAM-04)
- numGminSteps=1 — matches (DIFF-PARAM-24)
- numSrcSteps=1 — matches (DIFF-PARAM-25)
- nodeDamping default — matches (DIFF-PARAM-28)
- dcMaxIter=100 — matches (DIFF-PARAM-07)
- dcTrcvMaxIter=50 — matches (DIFF-PARAM-09)
- deltaOld rotation — matches (DIFF-TRAN-05, merge into rotate-state-vectors)
- savedDelta formula — matches in batch mode (DIFF-TRAN-14)

---

## Priority Order for Implementation

### Wave 1 — NR Loop Restructure (CRITICAL, everything depends on this)
1. 1.1 — Move iteration limit before convergence
2. 1.2 — Unify CKTload (remove linear hoisting, single clear+stamp+load)
3. 1.3 — Merge INITF dispatchers into one
4. 1.4 — Add RHS vector swap
5. 1.5 — Add noncon=0 reset at loop top
6. 1.6 — Fold convergence return into INITF dispatcher

### Wave 2 — Matrix Factorization (CRITICAL, blocks convergence robustness)
7. 3.1 — Dual factorization paths
8. 3.2 — Singular matrix retry
9. 3.3 — Preorder step
10. 3.4 — Markowitz ordering (reorder path)
11. 3.5 — diagGmin timing

### Wave 3 — INITF Guards + ipass (HIGH, affects convergence correctness)
12. 4.1 — FIX->FLOAT guard + ipass
13. 4.2 — TRAN->FLOAT unconditional + conditional reorder
14. 4.3 — Damping guard fixes
15. 4.4 — maxIter floor verification
16. 2.3 — Add initSmsig mode

### Wave 4 — DCOP Flow (HIGH)
17. 2.1 — CKTop wrapper
18. 2.2 — DCOP finalization
19. 2.4 — Premature mode reset fix
20. 2.5 — CKTncDump diagnostics
21. 2.6 — Separate transient DCOP entry

### Wave 5 — Transient Loop Architecture (CRITICAL)
22. 5.1 — State rotation timing (move to before retry)
23. 5.3 — Centralized NIcomCof (ag[])
24. 5.4 — LTE order promotion timing
25. 5.7 — State copy ordering
26. 5.8 — ag[] zeroing at transition

### Wave 6 — Timestep Control (HIGH)
27. 6.1 — Initial delta formula
28. 6.2 — delmin computation
29. 6.3 — Breakpoint epsilon
30. 6.4 — CKTbreak flag
31. 6.5 — Unconditional firsttime /10

### Wave 7 — UIC + Nodesets (HIGH)
32. 7.1 — UIC bypass
33. 7.2 — Nodeset/IC 1e10 enforcement

### Wave 8 — Parameters + Missing Capabilities (MEDIUM)
34. 8.1 — Add 6 missing parameters
35. 8.2 — Extract 3 hardcoded values to parameters
36. 8.3 — Fix naming inversions
37. 9.1 — NEWTRUNC voltage-based LTE
38. 5.2 — CKTaccept device callback
39. 5.5 — End-time check
40. 5.6 — Output data state

### Wave 9 — Gmin/Source Stepping (MEDIUM)
41. 10.1-10.6 — All gmin/source stepping fixes

### Wave 10 — Extended Capabilities (LOWER)
42. 9.2 — GEAR integration
43. 9.3 — 8 state arrays
44. 9.4 — Device bypass
45. 11.1-11.2 — Predictor fixes
46. 12.1-12.3 — Evaluate extra states for removal
