# State Machine Comparison Report

Comparison of three YAML inventories:
- **ngspice.yaml** (58 states) -- generated from ngspice C source in isolation
- **ours.yaml** (87 states) -- generated from our TypeScript source in isolation
- **catalog.yaml** (47 states) -- pre-populated unified catalog by a previous agent

---

## Section A: ngspice.yaml vs catalog.yaml

### A.1 STRUCTURAL -- States in ngspice.yaml missing from catalog.yaml

The following 35 ngspice states have no corresponding catalog entry:

| ngspice state ID | Line | Description |
|---|---|---|
| `dcop_entry` | 227 | DCop() entry point |
| `cktop_initial_solve` | 247 | CKTop convergence aid wrapper entry |
| `cktop_converged` | 317 | CKTop return success |
| `cktop_failed` | 340 | CKTop all aids exhausted |
| `niiter_loop_entry` | 363 | NIiter entry point |
| `niiter_check_uic_bypass` | 388 | UIC bypass check |
| `niiter_uic_single_load` | 406 | UIC single-load shortcut |
| `niiter_check_reinit` | 421 | Check NIUNINITIALIZED |
| `allocate_rhs_vectors` | 440 | NIreinit allocates CKTrhs etc. |
| `clear_noncon_and_load` | 461 | Top of NR for(;;) loop |
| `cktload_devices` | 482 | CKTload device evaluation |
| `apply_nodesets_and_ics` | 516 | Nodeset/IC enforcement in CKTload |
| `preorder_matrix` | 535 | SMPpreOrder one-time permutation |
| `lu_factorize_with_reorder` | 559 | SMPreorder full pivot reorder |
| `lu_factorize_numerical` | 581 | SMPluFac numerical-only factorization |
| `sparse_solve` | 605 | SMPsolve forward/back substitution |
| `check_iteration_limit` | 629 | iterno > maxIter check |
| `check_node_convergence` | 649 | NIconvTest node convergence |
| `apply_newton_damping` | 674 | Node damping in NIiter |
| `check_initf_and_transition` | 694 | INITF state machine dispatcher |
| `transition_jct_to_fix` | 731 | MODEINITJCT -> MODEINITFIX |
| `transition_fix_to_float` | 749 | MODEINITFIX -> MODEINITFLOAT |
| `transition_tran_to_float` | 766 | MODEINITTRAN -> MODEINITFLOAT |
| `transition_pred_to_float` | 782 | MODEINITPRED -> MODEINITFLOAT |
| `transition_smsig_to_float` | 797 | MODEINITSMSIG -> MODEINITFLOAT |
| `swap_rhs_vectors` | 812 | CKTrhsOld <-> CKTrhs pointer swap |
| `niiter_return_ok` | 846 | NIiter return OK |
| `niiter_return_iterlim` | 866 | NIiter return E_ITERLIM |
| `niiter_return_error` | 886 | NIiter return fatal error |
| `dcop_finalize` | 909 | DCop post-CKTop finalization |
| `dcop_set_smsig_mode` | 923 | Set MODEINITSMSIG for small-signal extraction |
| `dcop_final_load` | 939 | Final CKTload in MODEINITSMSIG |
| `dcop_output` | 956 | CKTdump output results |
| `dcop_failed` | 973 | DCop failure handler |
| `tran_init` | 990 | TRANinit entry |

The catalog lumped many of these into coarser-grained states:
- The entire NR inner loop (`clear_noncon_and_load` through `swap_rhs_vectors`, 16 states in ngspice) is represented by only 8 states in the catalog.
- The CKTop wrapper layer (`cktop_initial_solve`, `cktop_converged`, `cktop_failed`) is entirely absent from the catalog, which jumps directly from `attempt_direct_nr` to `attempt_gmin_stepping`.
- DCOP finalization (`dcop_finalize`, `dcop_set_smsig_mode`, `dcop_final_load`, `dcop_output`) is entirely absent. The catalog jumps from acceptance to `begin_transient_step`.
### A.2 STRUCTURAL -- States in catalog.yaml missing from ngspice.yaml

| catalog state ID | Line | Description |
|---|---|---|
| `allocate_runtime_arrays` | 16 | Setup allocation |
| `create_timestep_controller` | 35 | Timestep controller init |
| `create_history_stores` | 62 | History/diagnostic stores |
| `validate_pool_offsets` | 82 | Pool offset validation (ours-only, marked present_in: [ours]) |
| `update_charge_flux` | 722 | Post-NR charge update |
| `device_bypass_check` | 1045 | Device bypass (ngspice-only, marked present_in: [ngspice]) |
| `method_startup_bdf1` | 1070 | BDF-1 startup forcing |
| `detect_ringing_switch_bdf2` | 1108 | Ringing detection |
| `bdf2_stable_exit` | 1129 | BDF-2 stable exit |
| `breakpoint_reset_method` | 1147 | Breakpoint method reset |
| `compute_integration_coefficients` | 848 | Integration coefficient computation |
| `integrate_charge` | 870 | Companion model integration |
| `compute_lte_divided_differences` | 890 | CKTterr divided differences |
| `device_load_initjct` | 919 | InitJct device behavior |
| `device_load_inittran` | 938 | InitTran device behavior |
| `device_load_initpred` | 954 | InitPred device behavior |
| `device_load_initfix` | 970 | InitFix device behavior |

Several of these catalog states (`device_load_*`, `compute_integration_coefficients`, `integrate_charge`, `compute_lte_divided_differences`) represent behavior that ngspice.yaml documents inline within other states. The catalog broke these out into separate states, creating states that do not map 1:1 to ngspice.yaml.

### A.3 BEHAVIORAL -- States with differing edges or conditions

| catalog state | ngspice state(s) | Difference |
|---|---|---|
| `attempt_direct_nr` (L141) | `cktop_initial_solve` (L247) | Catalog omits the CKTnoOpIter bypass path. ngspice can skip NIiter entirely if CKTnoOpIter is set, going directly to gmin stepping. The catalog makes this unconditional. |
| `factor_matrix` (L435) | `preorder_matrix` (L535) + `lu_factorize_with_reorder` (L559) + `lu_factorize_numerical` (L581) | Catalog collapses three distinct states into one. Does not model the preorder step or the retry-from-top-of-loop path on E_SINGULAR. |
| `check_nr_convergence` (L570) | `check_node_convergence` (L649) + `check_initf_and_transition` (L694) | Catalog merges convergence checking with INITF transitions into a single state. |
| `accept_dcop_solution` (L351) | `dcop_finalize` (L909) + `dcop_set_smsig_mode` (L923) + `dcop_final_load` (L939) + `dcop_output` (L956) | Catalog skips the entire DCOP finalization sequence. ngspice does MODEINITSMSIG load + output dump + SOA check. |
| `restore_state_for_retry` (L623) | `tran_rotate_state_vectors` (L1266) + `tran_advance_time` (L1292) | Catalog conflates state rotation and time advance. ngspice rotates the state ring at the outer loop level, then advances time at the retry loop top. |
| `begin_transient_step` (L602) | `tran_accepted_timepoint` (L1148) + `tran_call_cktaccept` (L1171) + `tran_output_data` (L1192) + `tran_check_end_time` (L1208) + `tran_compute_next_delta` (L1226) + `tran_breakpoint_handling` (L1248) | Catalog collapses 6 ngspice states into one `begin_transient_step`. |

### A.4 BEHAVIORAL -- Edge condition differences

| catalog state | Difference |
|---|---|
| `attempt_gmin_stepping` (L220) | Catalog says edges_in from attempt_direct_nr. ngspice.yaml has `gmin_stepping` reached from `cktop_initial_solve` via the CKTop wrapper. The catalog removes the CKTop indirection entirely. |
| `compute_predictor` (L644) | Catalog says predictor_enabled default: "true (ngspice), false (ours)". ngspice predictor is gated by #ifdef PREDICTOR (compile-time), not a runtime default. |
| `run_transient_nr` (L684) | Catalog says transient_max_iter default: "10 (effective 100)". NIiter enforces maxIter >= 100 as a floor. The "effective 100" is correct but obscures the nominal value of 10. |

### A.5 PARAMETERS -- ngspice.yaml parameters missing from catalog.yaml

The catalog has NO parameters section. All 24 parameters documented in ngspice.yaml (lines 28-201) have no catalog counterpart. Parameters are referenced only inline in catalog state attributes.
---

## Section B: ours.yaml vs catalog.yaml

### B.1 STRUCTURAL -- States in ours.yaml missing from catalog.yaml

61 ours.yaml states have no direct catalog counterpart. Key groups:

**Lifecycle states (5):** `engine_init`, `allocate_solver_infrastructure`, `seed_breakpoints`, `engine_ready`, `engine_reset`, `engine_configure`, `engine_error_state`

**DCOP detail states (14):** `dcop_begin`, `dcop_reset_state_pool`, `dcop_init_element_state`, `dcop_direct_nr`, `dcop_prime_junctions`, `dcop_direct_check_converged`, `dcop_store_result`, `dcop_write_initial_charge`, `dcop_seed_history`, `dcop_set_analysis_mode_tran`, `dcop_seed_companion_state`, `dcop_return_success`, `dcop_return_failure`

**Gmin/Source stepping sub-states (12):** `dcop_gmin_stepping`, `dcop_gmin_zero_state`, `dcop_gmin_sub_solve`, `dcop_gmin_sub_solve_check`, `dcop_gmin_adapt_factor`, `dcop_gmin_sub_solve_failed`, `dcop_gmin_final_clean_solve`, `dcop_source_stepping`, `dcop_src_zero_state`, `dcop_src_scale_sources`, `dcop_src_sub_solve`, `dcop_src_sub_solve_check`, `dcop_src_adapt_raise`, `dcop_src_sub_solve_failed`, `dcop_src_final_clean_solve`

**NR loop internals (18):** `nr_initialize_operating_points`, `nr_stamp_linear`, `nr_capture_linear_rhs`, `nr_stamp_nonlinear`, `nr_stamp_reactive_companion`, `nr_finalize_matrix`, `nr_save_linear_base`, `nr_add_diagonal_gmin`, `nr_singular_matrix_abort`, `nr_blame_tracking`, `nr_post_iteration_hook`, `nr_dcop_mode_ladder_transition`, `nr_check_can_converge`, `nr_restore_linear_base`

**Transient detail states (12):** `transient_restore_state0_from_state1`, `transient_set_delta_old_current`, `transient_rotate_state_pool`, `transient_refresh_element_refs`, `transient_push_node_voltage_history`, `transient_push_element_history`, `transient_advance_timestep_controller`, `transient_check_method_switch`, `transient_try_order_promotion`, `transient_update_companion_state`, `transient_update_element_state`, `transient_schedule_breakpoints`, `transient_step_complete`

**Inline behavior states (7):** `limit_junction_voltages_pnjlim`, `limit_junction_voltages_fetlim`, `limit_junction_voltages_limvds`, `integrate_capacitor_charge`, `integrate_inductor_flux`, `truncation_error_check`, `temperature_dependent_param_calc`

### B.2 STRUCTURAL -- States in catalog.yaml missing from ours.yaml

| catalog state ID | Line | Description |
|---|---|---|
| `device_bypass_check` | 1045 | Marked present_in: [ngspice] only. Not implemented in ours. |
| `device_load_initjct` | 919 | Ours models this as `dcop_prime_junctions` (L327). |
| `device_load_inittran` | 938 | Ours models this inline in `transient_stamp_companions` (L1239). |
| `device_load_initpred` | 954 | Ours models this inline in `transient_predict_voltages` (L1226). |
| `device_load_initfix` | 970 | Ours handles inside `nr_update_operating_points`. |

### B.3 BEHAVIORAL -- Edge condition differences

| catalog state | ours state(s) | Difference |
|---|---|---|
| `accept_dcop_solution` (L351) | `dcop_store_result` through `dcop_seed_companion_state` (L361-430) | Catalog merges 5 distinct ours states into one. |
| `restore_state_for_retry` (L623) | `transient_retry_loop_entry` + `transient_restore_state0_from_state1` + `transient_set_delta_old_current` + `transient_advance_sim_time` (L1168-1210) | Catalog merges 4 ours states into one. |
| `accept_transient_step` (L812) | `transient_accept_timestep` through `transient_step_complete` (L1442-1599) | Catalog merges 12 ours states into one. |
| `run_transient_nr` (L684) | `nr_initialize_operating_points` through `nr_return_success`/`nr_return_failure` | Catalog wraps entire NR loop as a single state. Ours has 20+ states. |

### B.4 PARAMETERS -- ours.yaml parameters missing from catalog.yaml

All 18 parameters documented in ours.yaml (lines 33-152) have no catalog counterpart.
---

## Section C: ngspice.yaml vs ours.yaml (Direct Engine Comparison)

This is the most critical section.

### C.1 STRUCTURAL -- States in ngspice.yaml with no equivalent in ours.yaml

| ngspice state ID | Line | Significance |
|---|---|---|
| `niiter_check_uic_bypass` | 388 | **Missing UIC bypass.** ngspice checks MODETRANOP && MODEUIC and if true, does a single CKTload and returns OK with no NR iteration. Ours has `uic` as a parameter (L136) but no single-load bypass path in the NR loop. |
| `niiter_uic_single_load` | 406 | Same -- the single-load-and-return path for UIC. |
| `niiter_check_reinit` | 421 | **Missing NIreinit check.** ngspice lazy-allocates vectors on first call. Ours allocates at init time. Different architecture, not a behavioral gap. |
| `allocate_rhs_vectors` | 440 | Same -- lazy allocation in NIreinit. |
| `apply_nodesets_and_ics` | 516 | **Missing nodeset/IC enforcement in CKTload.** ngspice applies nodesets (1e10 conductance) and ICs inside CKTload during MODEDC. Ours handles initFix via element-level updateOperatingPoint but lacks explicit 1e10 conductance nodeset stamps. |
| `preorder_matrix` | 535 | **Missing preorder step.** ngspice does one-time column/row permutation (SMPpreOrder). Ours uses AMD ordering inside `nr_finalize_matrix` which serves a similar role but is architecturally different. |
| `lu_factorize_with_reorder` | 559 | **Missing reorder-on-demand.** ngspice has two factorization paths: full pivot reorder (NISHOULDREORDER) vs numerical-only. Ours has a single `nr_lu_factorize` with no NISHOULDREORDER retry. |
| `lu_factorize_numerical` | 581 | **Missing numerical-only factorization path.** ngspice can reuse pivot order for speed. Ours always does full factorization. |
| `check_iteration_limit` | 629 | **No separate iteration limit check.** Ours checks inside `nr_check_can_converge` (L1029) rather than before convergence checking. |
| `transition_smsig_to_float` | 797 | **Missing MODEINITSMSIG.** Used in DCOP finalization for small-signal parameter extraction. Ours has no equivalent. |
| `dcop_finalize` | 909 | **Missing DCOP finalization sequence.** Ours returns directly from `dcop_return_success`. ngspice does MODEINITSMSIG -> final CKTload -> CKTdump -> SOA check. |
| `dcop_set_smsig_mode` | 923 | Part of missing DCOP finalization. |
| `dcop_final_load` | 939 | Part of missing DCOP finalization. |
| `dcop_output` | 956 | Part of missing DCOP finalization. |
| `tran_init` | 990 | **Different transient init architecture.** ngspice has dedicated TRANinit + DCtran entry. Ours handles in engine_init/engine_configure. |
| `tran_compute_initial_delta` | 1007 | Part of different transient init architecture. |
| `tran_apply_initial_conditions` | 1027 | **Missing CKTic call.** ngspice calls CKTic() for nodeset/IC/MODEUIC setup. Ours handles during element initState. |
| `tran_dcop_entry` | 1047 | **Different transient DCOP architecture.** ngspice has a separate CKTop call for transient OP. Ours reuses `dcop_begin` for all DCOP calls. |
| `tran_dcop_converged` | 1064 | Part of different architecture. |
| `tran_dcop_failed` | 1079 | Part of different architecture. |
| `tran_init_state_vectors` | 1093 | **Missing explicit deltaOld initialization.** ngspice initializes CKTdeltaOld[0..6] = CKTmaxStep here. Ours does this in TimestepController constructor. |
| `tran_set_initial_mode` | 1111 | **Missing explicit MODETRAN set.** ngspice sets MODETRAN|MODEINITTRAN after transient DCOP. Ours sets initMode=initTran inside transient_stamp_companions when firsttime is true. |
| `tran_copy_state0_to_state1` | 1128 | **Different state copy location.** ngspice copies state0->state1 after DCOP and ag[] zeroing. Ours does this inside dcop_seed_history. |
| `tran_accepted_timepoint` | 1148 | **Missing explicit accepted timepoint state.** ngspice has nextTime label (650) as outer loop re-entry. Ours enters from engine_ready -> transient_step_entry. |
| `tran_call_cktaccept` | 1171 | **Missing CKTaccept device callback.** ngspice calls DEVaccept per device type (e.g., LTRA history). Ours has no equivalent per-device acceptance callback. |
| `tran_output_data` | 1192 | **Missing explicit output state.** ngspice calls CKTdump. Ours handles via measurement observers in transient_step_complete. |
| `tran_check_end_time` | 1208 | **Missing end-time check.** ngspice checks |CKTtime - CKTfinalTime| < CKTminBreak. Ours is streaming -- step() returns to caller. |
| `tran_compute_next_delta` | 1226 | **Different timestep flow.** ngspice computes next delta in a dedicated state. Ours does this inside transient_advance_timestep_controller and transient_get_clamped_dt. |
| `tran_breakpoint_handling` | 1248 | Part of different timestep flow. |
| `tran_rotate_state_vectors` | 1266 | **Different state rotation timing.** ngspice rotates at START of outer time loop (before retry). Ours rotates at ACCEPTANCE time (transient_rotate_state_pool, L1458). Fundamental architectural difference. |
| `tran_compute_integration_coefficients` | 1317 | **Missing centralized NIcomCof.** ngspice computes CKTag[] centrally. Ours computes ag0 locally in each element. |
| `tran_predict_solution` | 1341 | **Different predictor architecture.** ngspice calls NIpred centrally. Ours calls predictVoltages from transient_predict_voltages (L1226). |
| `tran_set_initpred_mode` | 1393 | Present in ours as `transient_set_initmode_initpred` (L1268). Naming difference. |
| `tran_firsttime_state_copy` | 1416 | Present in ours as `transient_firsttime_copy_state` (L1284). Naming difference. |
| `tran_set_delta_to_delmin` | 1576 | **Missing explicit delmin-set state.** Ours handles inside transient_delmin_check (L1397). |
### C.2 STRUCTURAL -- States in ours.yaml with no equivalent in ngspice.yaml

| ours state ID | Line | Significance |
|---|---|---|
| `engine_init` | 163 | **Lifecycle management.** ngspice is procedural C with no engine object. |
| `allocate_solver_infrastructure` | 176 | Part of lifecycle. |
| `seed_breakpoints` | 189 | **Explicit breakpoint seeding.** ngspice seeds inside DCtran init. |
| `engine_ready` | 208 | **STOPPED state.** ngspice is batch, not interactive. |
| `engine_reset` | 239 | **Reset capability.** No ngspice equivalent. |
| `engine_configure` | 252 | **Runtime reconfiguration.** No ngspice equivalent. |
| `dcop_reset_state_pool` | 282 | **Pool reset.** ngspice has no state pool object. |
| `dcop_init_element_state` | 298 | **Explicit element initState.** ngspice handles in device setup. |
| `dcop_write_initial_charge` | 380 | **Explicit post-DCOP charge computation.** ngspice computes charge inside DEVload. |
| `dcop_seed_history` | 393 | **Explicit history seeding.** ngspice copies state0->state1 inline. |
| `dcop_set_analysis_mode_tran` | 406 | **Explicit analysis mode switch.** ngspice sets mode bits inline. |
| `dcop_seed_companion_state` | 419 | **Explicit companion seeding.** No ngspice equivalent. |
| `nr_stamp_linear` | 714 | **Linear stamp hoisting.** ngspice re-stamps everything every iteration. Ours hoists linear stamps. |
| `nr_capture_linear_rhs` | 727 | Part of linear stamp hoisting. |
| `nr_stamp_reactive_companion` | 756 | **Separate reactive companion stamping.** ngspice stamps inside DEVload. |
| `nr_finalize_matrix` | 769 | **COO to CSC conversion.** ngspice uses pre-allocated sparse matrix. |
| `nr_save_linear_base` | 788 | Part of linear stamp hoisting. |
| `nr_restore_linear_base` | 1051 | Part of linear stamp hoisting. |
| `nr_blame_tracking` | 984 | **Blame diagnostics.** No ngspice equivalent. |
| `nr_post_iteration_hook` | 1000 | **Instrumentation hook.** No ngspice equivalent. |
| `nr_dcop_mode_ladder_transition` | 1016 | **Separate ladder transition state.** ngspice handles all INITF in one dispatcher. |
| `nr_check_can_converge` | 1029 | **Convergence gate.** ngspice returns directly from check_initf_and_transition. |
| `nr_linear_shortcircuit` | 884 | **Linear circuit fast path.** ngspice has no special case for linear-only circuits. |
| `transient_restore_state0_from_state1` | 1184 | **Explicit state restore for retry.** ngspice rotates arrays once; ours copies state0 from state1 at retry entry. |
| `transient_set_delta_old_current` | 1197 | **Explicit deltaOld[0] update.** ngspice updates inline. |
| `transient_rotate_state_pool` | 1458 | **Acceptance-time rotation.** ngspice rotates at outer loop start. |
| `transient_refresh_element_refs` | 1471 | **Element reference refresh.** ngspice uses pointers that don't need refreshing. |
| `transient_push_node_voltage_history` | 1484 | **Node voltage history push.** ngspice does this inside CKTaccept. |
| `transient_push_element_history` | 1497 | **Element voltage history.** No direct ngspice equivalent -- used for ringing detection. |
| `transient_advance_timestep_controller` | 1510 | **Timestep controller advance.** ngspice handles inline in DCtran. |
| `transient_check_method_switch` | 1523 | **Ringing detection check.** ngspice oscillation detection varies by version. |
| `transient_try_order_promotion` | 1536 | **Order promotion.** In ngspice, part of tran_truncation_error_check. |
| `transient_update_companion_state` | 1549 | **Post-acceptance companion update.** No ngspice equivalent. |
| `transient_update_element_state` | 1562 | **Post-acceptance element state update.** No ngspice equivalent. |
| `transient_schedule_breakpoints` | 1575 | **Post-acceptance breakpoint scheduling.** ngspice handles in tran_breakpoint_handling. |
| `transient_step_complete` | 1588 | **Step completion.** ngspice loops; ours returns to caller. |
| `engine_error_state` | 1429 | **Error terminal state.** ngspice returns error code; ours enters ERROR state. |
| `temperature_dependent_param_calc` | 1685 | **Explicit temperature param computation.** ngspice handles in DEVsetup/DEVtemp. |
### C.3 BEHAVIORAL -- INITF/mode flag handling differences

| Aspect | ngspice | ours |
|---|---|---|
| **INITF representation** | Bitmask flags: MODEINITJCT, MODEINITFIX, MODEINITFLOAT, MODEINITTRAN, MODEINITPRED, MODEINITSMSIG (L694-810) | String-typed pool.initMode: initJct, initFix, initFloat, initTran, initPred (no initSmsig) |
| **MODEINITSMSIG** | Present. Used in DCOP finalization for small-signal extraction (L797, L923-954). | **Missing entirely.** No initSmsig mode. No DCOP finalization that uses it. |
| **INITF transition location** | Inside NIiter after convergence check (check_initf_and_transition, L694). Single dispatcher. | Split between nr_transient_mode_automaton (L926, transient) and nr_dcop_mode_ladder_transition (L1016, DCOP). Two separate state machines. |
| **JCT->FIX transition** | Unconditional after any MODEINITJCT iteration (L731). Sets NISHOULDREORDER. | Unconditional. Calls solver.forceReorder() (L1027). Equivalent. |
| **FIX->FLOAT guard** | CKTnoncon == 0 (L749). Uses ipass counter for hadNodeset extra pass. | noncon === 0 AND ladderModeIter > 0 (L1027). Uses ladderModeIter instead of ipass. |
| **TRAN->FLOAT transition** | Unconditional (L766). Sets NISHOULDREORDER if iterno <= 1. | Only at iter 0 (L940). Always forceReorders. |
| **PRED->FLOAT transition** | Unconditional (L782). | Unconditional (L940). Equivalent. |

### C.4 BEHAVIORAL -- Loop nesting differences

| Aspect | ngspice | ours |
|---|---|---|
| **State vector rotation timing** | Rotated at TOP of outer time loop, BEFORE retry loop (tran_rotate_state_vectors, L1266). Pointer rotation -- no data copy. | Rotated at ACCEPTANCE time, AFTER retry loop exits (transient_rotate_state_pool, L1458). Data copy involved. |
| **Retry mechanism** | State arrays already rotated; retry operates on rotated buffer. On retry, CKTtime -= CKTdelta but state arrays NOT un-rotated. | State0 explicitly restored from state1 at retry entry (transient_restore_state0_from_state1, L1184). Rotation has not happened yet. |
| **deltaOld rotation timing** | Rotated at outer loop start (L1278). deltaOld[0] = CKTdelta at tran_advance_time (L1314). | Rotated BEFORE retry loop (transient_rotate_delta_old, L1155). deltaOld[0] updated via setDeltaOldCurrent at each retry (L1197). |
| **Outer vs inner loop boundary** | Outer = nextTime label (650). Inner = for(;;) at label 600. State rotation between them. | Outer = transient_step_entry (called by user). Inner = transient_retry_loop_entry. DeltaOld rotation before inner; state rotation at acceptance (after inner). |

### C.5 BEHAVIORAL -- Convergence checking differences

| Aspect | ngspice | ours |
|---|---|---|
| **Convergence check ordering** | 1. check_iteration_limit (L629) -- iterno > maxIter FIRST. 2. check_node_convergence (L649). 3. apply_newton_damping (L674). 4. check_initf_and_transition (L694). | 1. nr_update_operating_points (L897). 2. nr_force_noncon_iter0 (L913). 3. nr_transient_mode_automaton (L926). 4. nr_node_damping (L942). 5. nr_check_global_convergence (L955). 6. nr_check_element_convergence (L971). 7. nr_check_can_converge (L1029) -- iteration limit HERE. |
| **Iteration limit check location** | BEFORE convergence test, immediately after solve (L629). If exceeded, return E_ITERLIM without checking convergence. | AFTER convergence test, inside nr_check_can_converge (L1029). Checks convergence first, then iteration limit. |
| **NIconvTest skip condition** | Skipped when CKTnoncon != 0 OR iterno == 1 (L670). | Skipped when noncon > 0 OR iteration == 0 (L967). Equivalent (0-based vs 1-based). |
| **Element convergence** | Only if NEWCONV defined: CKTconvTest -> DEVconvTest (L669). | Always available: assembler.checkAllConverged() (L971). Short-circuits unless detailedConvergence flag. |
| **Convergence parameter names** | voltTol (1e-6 V) for voltage nodes, abstol (1e-12 A) for branches (L665). | abstol (1e-6 V) for voltage nodes, iabstol (1e-12 A) for branches (L967). Same values, different names. |

### C.6 BEHAVIORAL -- Timestep control flow differences

| Aspect | ngspice | ours |
|---|---|---|
| **Initial delta** | delta = MIN(CKTfinalTime/100, CKTstep) / 10 (L1019). Further /10 on firsttime (L1242). | clamp(firstStep, minTimeStep, maxTimeStep) with /=10 on first call proximity (L1153). Different formula. |
| **delmin value** | CKTdelmin = 1e-11 * CKTmaxStep (L1003). For maxStep=10e-6, delmin=1e-16. | minTimeStep = 1e-15 (L89). Ours ~10x larger. |
| **NR failure dt reduction** | CKTdelta /= 8 (L1545). | dt /= 8 (L1395). Equivalent. |
| **LTE acceptance threshold** | newdelta > 0.9 * CKTdelta (L1466). | worstRatio < 1/0.9 = 1.111 (L1356). Equivalent. |
| **LTE order promotion timing** | Inside tran_truncation_error_check: tries order 2, keeps if newdelta <= 1.05*delta (L1480). | In transient_try_order_promotion (L1536) at acceptance time. Same threshold, different timing. |
| **End-time check** | Explicit: |CKTtime - CKTfinalTime| < CKTminBreak (L1217). | **No end-time check.** Streaming engine -- step() returns to caller. |
| **CKTaccept callback** | CKTaccept(ckt) calls DEVaccept per device, rotates predictor ring, clears breakpoints (L1171). | **No CKTaccept equivalent.** Breakpoint clearing in transient_advance_timestep_controller. |
| **Breakpoint epsilon** | CKTminBreak = CKTmaxStep * 5e-5 (L1022). | minTimeStep * 0.5. Much smaller. |
| **savedDelta** | CKTsaveDelta = CKTfinalTime/50 (L1108). | savedDelta = tStop/50 or maxTimeStep if streaming. |
### C.7 BEHAVIORAL -- Matrix factorization differences

| Aspect | ngspice | ours |
|---|---|---|
| **Factorization strategy** | Two paths: lu_factorize_with_reorder (full Markowitz pivot, L559) and lu_factorize_numerical (reuse pivot order, L581). Controlled by NISHOULDREORDER flag. | Single path: nr_lu_factorize (L820). Left-looking sparse LU with partial pivoting. Always full factorization. |
| **Reorder trigger** | NISHOULDREORDER set by: MODEINITJCT, MODEINITTRAN (iterno==1), E_SINGULAR from SMPluFac (L556). | forceReorder() called by mode ladder transitions (JCT->FIX, TRAN->FLOAT). No singular-retry path. |
| **Singular matrix handling** | E_SINGULAR from lu_factorize_numerical -> NISHOULDREORDER -> loops back to clear_noncon_and_load for retry with full reorder (L593). | Singular from nr_lu_factorize -> nr_singular_matrix_abort -> nr_return_failure (L842). No retry. |
| **Ordering method** | Markowitz pivot selection in spOrderAndFactor (L577). | AMD ordering in nr_finalize_matrix (L786). |
| **Linear stamp optimization** | None -- CKTload zeros and re-stamps everything every iteration (L499). | Linear stamps hoisted: stamp once, save base, restore on iter > 0, only re-stamp nonlinear (7 states: L714-1062). |

### C.8 BEHAVIORAL -- State vector management differences

| Aspect | ngspice | ours |
|---|---|---|
| **State array count** | 8 arrays: CKTstates[0..7]. Supports Gear orders up to 6. | 4 arrays: states[0..3]. Caps at order 2. |
| **Rotation mechanism** | Ring buffer rotation: temp = states[maxOrder+1]; states[i+1] = states[i]. Pointer rotation -- no data copy (L1282). | Pool rotation: acceptTimestep() rotates 4-slot ring, seeds state0 from state1 (L1459). Data copy. |
| **deltaOld slot count** | 7 slots: deltaOld[0..6] (L1279). | 7 slots: deltaOld[0..6] (L1166). Equivalent. |
| **ag[] coefficient storage** | Centralized: CKTag[0..order] computed by NIcomCof (L1332). | Distributed: each element derives ag0 locally from pool.dt and method/order. |
| **firsttime state copy** | state1 -> state2, state3 on firsttime (L1428). | state0 -> state1, then seedFromState1 (state1 -> state2, state3) (L1295). Equivalent final result. |

### C.9 PARAMETERS -- Differences

| Parameter | ngspice value | ours value | Difference |
|---|---|---|---|
| CKTvoltTol / abstol | 1e-6 V (L37) | 1e-6 V (L44) | Same value, different name. ngspice voltTol = our abstol. |
| CKTabstol / iabstol | 1e-12 A (L43) | 1e-12 A (L48) | Same value, different name. ngspice abstol = our iabstol. |
| CKTdelmin / minTimeStep | Computed: 1e-11 * CKTmaxStep (L84) | Fixed: 1e-15 (L89) | Different derivation. For maxStep=10e-6, ngspice delmin=1e-16, ours=1e-15. |
| CKTintegrateMethod / -- | TRAPEZOIDAL or GEAR (L126) | Not a parameter | Ours uses method strings (bdf1, trapezoidal, bdf2). No GEAR method. |
| CKTlteReltol / -- | 1e-3 (L144) | Not present | **Missing NEWTRUNC parameters.** ngspice has voltage-based LTE with its own reltol/abstol. Ours only has charge-based LTE. |
| CKTlteAbstol / -- | 1e-6 V (L150) | Not present | Same as above. |
| CKTgminFactor / -- | 10.0 (L180) | Not a parameter (hardcoded) | Hardcoded in ours at initial_factor=10. |
| CKTsrcFact / -- | 1.0 (L186) | Not a parameter | Internal variable only in ours. |
| xmu / -- | 0.5 (L198) | Not a parameter (hardcoded) | Both hardcode 0.5. ngspice documents it; ours does not. |
| predictor | Compile-time #ifdef PREDICTOR | Runtime false (L131) | Different default. ngspice typically has PREDICTOR compiled in. Ours defaults off. |
| PIVOT_THRESHOLD / CKTpivotRelTol | 1e-3 (L161) | 1e-3 (L143) | Same. |
| PIVOT_ABS_THRESHOLD / CKTpivotAbsTol | 1e-13 (L156) | 1e-13 (L149) | Same. |
---

## Section D: Catalog Accuracy Assessment

### D.1 -- Catalog papered over real differences

1. **State rotation timing (C.4).** The catalog says in accept_transient_step divergences: "ngspice does state ring rotation inside the retry loop. Ours does it at acceptance. Functionally equivalent because ours copies state0<-state1 at retry entry instead." This is correct but the catalog models both as a single accept_transient_step, hiding the fact that the retry mechanisms are fundamentally different (ngspice: rotate-then-retry vs ours: copy-then-retry). The structural difference is invisible in the catalog.

2. **Matrix factorization retry (C.7).** The catalog factor_matrix says "ngspice has a NISHOULDREORDER retry mechanism before giving up on singularity. Ours returns non-converged immediately on singular matrix." This is documented as a divergence note, but the catalog models both as a single factor_matrix state. The ngspice retry-from-top-of-loop path (E_SINGULAR -> NISHOULDREORDER -> back to clear_noncon_and_load) is a structural difference that changes the state graph topology, not just a behavioral divergence.

3. **Convergence check ordering (C.5).** The catalog check_nr_convergence merges the iteration limit check, node convergence test, element convergence test, and INITF transitions into a single state. In ngspice, the iteration limit is checked BEFORE convergence (return immediately if exceeded). In ours, convergence is checked BEFORE the iteration limit. This ordering difference is invisible in the catalog.

4. **DCOP finalization (C.1).** The catalog has no states for DCOP finalization (MODEINITSMSIG, final load, output dump). The catalog accept_dcop_solution goes directly to begin_transient_step, as if DCOP finalization does not exist. This omits 4 ngspice states entirely.

5. **Linear stamp hoisting (C.7).** The catalog assemble_matrix notes that "ours hoists linear stamps" as a divergence, but models both engines as having the same state. In reality, ours has 7 states for matrix assembly while ngspice has 2 (clear+load, preorder). The single-state representation hides this.

6. **Predictor default (C.9).** The catalog says predictor_enabled default: "true (ngspice), false (ours)". ngspice predictor is not a runtime flag with a default -- it is a compile-time #ifdef. The catalog misrepresents this as a parameter difference.

### D.2 -- Catalog forced a common structure that does not match either engine

1. **NR loop structure.** ngspice has: clear_noncon -> CKTload -> preorder -> factor -> solve -> check_iterlim -> convergence -> damping -> INITF -> swap -> loop. Ours has: stamp_nonlinear -> stamp_reactive -> finalize -> gmin -> factor -> save_state0 -> solve -> update_OP -> force_noncon -> mode -> damping -> global_conv -> elem_conv -> blame -> hook -> ladder -> gate -> loop. The catalog imposes a third structure that matches neither: save_prev -> assemble -> factor -> save_state0 -> solve -> update_OP -> force_noncon -> mode -> damping -> convergence -> loop.

2. **Transient step structure.** ngspice: accepted_timepoint -> CKTaccept -> output -> check_end -> compute_delta -> breakpoint -> rotate_states -> advance_time -> comcof -> (predict) -> NIiter -> ... -> LTE -> accept/reject. Ours: step_entry -> save_prev -> get_dt -> rotate_delta -> retry_entry -> restore_state0 -> set_delta_old -> advance_time -> (predict) -> stamp_companions -> NR -> ... -> LTE -> accept/reject -> rotate_pool -> refresh -> push_history -> advance_controller -> method_switch -> order_promotion -> update_companion -> update_state -> schedule_breakpoints -> step_complete. The catalog: begin_step -> restore_retry -> predict -> stamp_companions -> run_NR -> ... -> LTE -> accept/reject. Closer to ours but loses significant detail.

3. **Device-load phase.** The catalog creates 4 device_load_* states and 3 apply_*lim states as separate entries. Neither engine inventory has these as separate state-machine states -- ngspice documents them as behavior within cktload_devices, and ours documents them as behavior within nr_update_operating_points and inline limiting states.

### D.3 -- Catalog missed states entirely

1. **UIC bypass** (niiter_check_uic_bypass, niiter_uic_single_load). The catalog does not mention the UIC single-load bypass path at all.

2. **CKTnoOpIter bypass.** ngspice cktop_initial_solve can skip directly to gmin stepping if CKTnoOpIter is set. Catalog attempt_direct_nr does not mention this.

3. **NIreinit / vector allocation** (niiter_check_reinit, allocate_rhs_vectors). Not mentioned.

4. **Preorder** (preorder_matrix). Catalog factor_matrix does not mention SMPpreOrder column permutation.

5. **CKTaccept** (tran_call_cktaccept). Catalog does not mention per-device acceptance callback.

6. **Output data** (tran_output_data). No state for data output during transient.

7. **End-time check** (tran_check_end_time). Not modeled. ngspice path is undocumented.

8. **Engine lifecycle** (engine_init, engine_ready, engine_reset, engine_configure, engine_error_state). Not modeled.

9. **DCOP finalization** (dcop_finalize, dcop_set_smsig_mode, dcop_final_load, dcop_output). Entirely absent.

10. **Blame tracking** (nr_blame_tracking), **post-iteration hook** (nr_post_iteration_hook). Not in catalog.

11. **Post-acceptance states.** Ours has 8 post-acceptance states (transient_rotate_state_pool through transient_step_complete). Catalog lists these as sub-items in description but does not model as separate states.

### D.4 -- Catalog got edge conditions wrong

1. **attempt_direct_nr edges_in** (catalog L141): Says from: clear_state_for_dcop, condition: "unconditional". In ngspice, the path goes through dcop_entry -> cktop_initial_solve -> niiter_loop_entry, with a CKTnoOpIter guard. Catalog removes this guard.

2. **accept_dcop_solution edges_in** (catalog L351): Lists edges from attempt_direct_nr, dynamic_gmin_adapt, etc. In ngspice, all go through cktop_converged first. In ours, through dcop_direct_check_converged or final_clean_solve states. Catalog collapses intermediate states.

3. **run_transient_nr divergences** (catalog L684): Says "Both floor the iteration limit to 100." This means CKTtranMaxIter=10 gets floored to 100 in NIiter. Transient NR gets 100 iterations, not 10. Significant operational difference from what the parameter name suggests.

4. **evaluate_lte divergences** (catalog L747): Says "ngspice has a NEWTRUNC voltage-based mode... Ours only implements charge-based CKTterr." Correct but incomplete -- NEWTRUNC uses different tolerances (CKTlteReltol, CKTlteAbstol) documented in ngspice.yaml but absent from catalog.

---

## Summary Statistics

| Metric | ngspice.yaml | ours.yaml | catalog.yaml |
|---|---|---|---|
| Total states | 58 | 87 | 47 |
| Parameters | 24 | 18 | 0 (none) |
| States with 1:1 catalog match | ~23 | ~22 | -- |
| States missing from catalog | 35 | 52+ | -- |
| Catalog states not in either engine | -- | -- | ~8 (device_load_*, integration detail states) |

The catalog is a useful high-level summary but significantly under-represents both engines. It collapses ~58 ngspice states into ~23 catalog equivalents and ~87 ours states into ~22 catalog equivalents. It misses the CKTop wrapper layer, DCOP finalization, NR loop internals (factorization strategy, iteration limit ordering), transient loop structure (acceptance processing, output, end-time check), UIC bypass, and all lifecycle management. Its divergence notes are often correct but incomplete, and it forces a common structure that matches neither engine accurately.
