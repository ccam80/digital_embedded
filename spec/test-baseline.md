# Test Baseline
- **Timestamp**: 2026-04-20T00:00:00Z
- **Phase**: pre-Phase-0 (Dead Code Removal)
- **Command**: `npm run test:q`
- **Result**: vitest 8592/8635 passing (43 failing, 10 skipped, 18.7s); playwright 476/488 passing (12 failing, 192.9s); combined 9068 passing, 55 failing
- **Source-of-truth detail**: `test-results/test-failures.json`

## Failing Tests (pre-existing — NOT regressions caused by this implementation)

| Test | Status | Summary |
|------|--------|---------|
| vitest:src/editor/__tests__/wire-current-resolver.test.ts::RLC junction: wire currents match element currents at every AC timestep | FAIL | expected 0 to be greater than 0.009000000000000001 |
| vitest:src/editor/__tests__/wire-current-resolver.test.ts::cross-component current equality through real compiled lrctest.dig | FAIL | expected 0 to be greater than 0.045000000000000005 |
| vitest:src/editor/__tests__/wire-current-resolver.test.ts::component-as-node KCL: wire at pin A ≈ wire at pin B ≈ body current | FAIL | expected 0 to be greater than 0 |
| vitest:src/components/active/__tests__/real-opamp.test.ts::large_signal_step | FAIL | Cannot read properties of undefined (reading '1') |
| vitest:src/components/active/__tests__/real-opamp.test.ts::small_signal_not_slew_limited | FAIL | Cannot read properties of undefined (reading '1') |
| vitest:src/solver/analog/stamp-helpers.ts::junction_cap_transient_matches_ngspice | FAIL | solver.allocElement is not a function |
| vitest:src/components/passives/__tests__/capacitor.test.ts::stampCompanion preserves V_PREV across calls (slot 2 tracks previous voltage) | FAIL | Cannot read properties of undefined (reading '2') |
| vitest:src/components/passives/__tests__/capacitor.test.ts::stampCompanion_uses_s1_charge_when_initPred | FAIL | expected -3 to not be close to -3, received difference is 0, but expected 0.005 |
| vitest:src/components/passives/__tests__/inductor.test.ts::stamps branch incidence and conductance entries | FAIL | expected 5 to be 4 // Object.is equality |
| vitest:src/components/passives/__tests__/tapped-transformer.test.ts::full_wave_rectifier — two diodes + CT ground produce DC output ≈ Vpeak_sec | FAIL | Singular at step 5 NR 17 |
| vitest:src/components/passives/__tests__/transformer.test.ts::power_conservation — P_primary ≈ P_secondary for k=0.99 within 10% | FAIL | expected 0.9975437318359646 to be less than 0.1 |
| vitest:src/components/passives/__tests__/transformer.test.ts::dc_blocks — DC source on primary produces ~0 secondary voltage in steady state | FAIL | expected 4.128440366972478 to be less than 0.25 |
| vitest:src/components/passives/__tests__/transmission-line.test.ts::step input arrives at port 2 approximately at delay τ | FAIL | expected 0.9999999992599999 to be greater than 0.9999999992599999 |
| vitest:src/components/passives/__tests__/transmission-line.test.ts::matched load produces no reflection — output voltage ≈ input/2 | FAIL | expected 0.33333343924051334 to be greater than 0.35 |
| vitest:src/components/passives/__tests__/transmission-line.test.ts::N=50 delay more accurate than N=5 | FAIL | expected 1.7999999268880629e-9 to be greater than 0.001 |
| vitest:src/components/semiconductors/__tests__/bjt.test.ts::common_emitter_active_ic_ib_bit_exact_vs_ngspice | FAIL | expected 0.000005674679845410129 to be 0.000005674679845410128 // Object.is equality |
| vitest:src/components/semiconductors/__tests__/triac.test.ts::conducts_positive_when_triggered | FAIL | expected 103.17450166223666 to be close to 100, received difference is 3.174501662236665, but expected 0.5 |
| vitest:src/components/semiconductors/__tests__/triac.test.ts::conducts_negative_when_triggered | FAIL | expected 103.1745016622365 to be close to 100, received difference is 3.1745016622364943, but expected 0.5 |
| vitest:src/components/sources/__tests__/ac-voltage-source.test.ts::rc_lowpass | FAIL | expected 5 to be less than 0.8644719901267445 |
| vitest:src/solver/analog/__tests__/bridge-compilation.test.ts::per-net ideal override on boundary group produces unloaded output adapter | FAIL | expected 0.02 to be +0 // Object.is equality |
| vitest:src/solver/analog/__tests__/buckbjt-convergence.test.ts::buckbjt_load_dcop_parity: rhsOld + noncon + diagGmin + srcFact bit-exact vs ngspice | FAIL | step 0 iter 0: rhsOld[V1:branch] divergence ours=0.009259065870845391 ng=0.009268473398412237 absDelta=0.000009407527566845583 |
| vitest:src/solver/coordinator.ts::transient stepping does not error after 50 steps | FAIL | Analog engine stagnation: simTime stuck at 3.0517578125e-15s |
| vitest:src/solver/coordinator.ts::survives 2000 transient steps without ERROR state | FAIL | Analog engine stagnation: simTime stuck at 3.0517578125e-15s |
| vitest:src/solver/coordinator.ts::survives 600µs of sim time (matches UI run duration) | FAIL | Analog engine stagnation: simTime stuck at 3.0517578125e-15s |
| vitest:src/solver/analog/__tests__/ckt-terr.test.ts::order 1 bdf1: returns finite positive timestep for non-trivial charges | FAIL | expected Infinity to be 2.645751312387466 |
| vitest:src/solver/analog/__tests__/ckt-terr.test.ts::constant charge history produces finite timestep (not Infinity) — abstol-gated | FAIL | expected Infinity to be 2.645751312387466 |
| vitest:src/solver/analog/__tests__/ckt-terr.test.ts::order 2 bdf2: returns sqrt-scaled timestep | FAIL | expected 9.222255689363639e-10 to be 9.474539396484565e-7 |
| vitest:src/solver/analog/__tests__/ckt-terr.test.ts::bdf2 order 2 returns positive finite timestep for cubic charge data | FAIL | expected 1.5060159361706635 to be 1.134042 |
| vitest:src/solver/analog/__tests__/ckt-terr.test.ts::gear_lte_factor_order_3 | FAIL | expected 0.00011149474795453514 to be 0.0010850276550489007 |
| vitest:src/solver/analog/__tests__/ckt-terr.test.ts::gear_lte_factor_order_5 | FAIL | expected 0.004815445525253121 to be 0.011718276157728014 |
| vitest:src/solver/analog/__tests__/ckt-terr.test.ts::gear_lte_factor_order_6 | FAIL | expected 0.012165248594803255 to be 0.022838897354229643 |
| vitest:src/solver/analog/__tests__/ckt-terr.test.ts::cktTerr_trap_order1_matches_ngspice | FAIL | expected 2.799999999999998e-7 to be 5.291502622129179e-10 |
| vitest:src/solver/analog/__tests__/ckt-terr.test.ts::cktTerr_trap_order2_matches_ngspice | FAIL | expected 0.0000015060159361706639 to be 1.1340420000000001e-24 |
| vitest:src/solver/analog/__tests__/ckt-terr.test.ts::cktTerr_gear_order1_sqrt | FAIL | expected 2.799999999999998e-7 to be 0.000529150262212918 |
| vitest:src/solver/analog/__tests__/ckt-terr.test.ts::gear_higher_order_root_is_order_plus_one | FAIL | expected 0.00011149612441591165 to be 0.0010850377014617293 |
| vitest:src/solver/analog/__tests__/dc-operating-point.test.ts::dcopFinalize_transitions_initMode_to_initFloat | FAIL | expected undefined to be 'initFloat' |
| vitest:src/solver/analog/__tests__/newton-raphson.test.ts::initTran_transitions_to_initFloat_after_iteration_0 | FAIL | expected undefined to be 'initFloat' |
| vitest:src/solver/analog/__tests__/newton-raphson.test.ts::initPred_transitions_to_initFloat_immediately | FAIL | expected undefined to be 'initFloat' |
| vitest:src/solver/analog/__tests__/mna-end-to-end.test.ts::rl_dc_steady_state_tight_tolerance | FAIL | expected 97.56098155858157 to be less than 0.1 |
| vitest:src/solver/analog/__tests__/newton-raphson.test.ts::transient_mode_allows_convergence_without_ladder | FAIL | expected undefined to be 'transient' |
| vitest:src/solver/analog/__tests__/newton-raphson.test.ts::ipass_skipped_without_nodesets | FAIL | expected 9 to be 7 |
| vitest:src/solver/analog/__tests__/harness/stream-verification.test.ts::10. limiting events: our engine captures events (Item 9) | FAIL | expected false to be true |
| vitest:src/solver/analog/__tests__/harness/stream-verification.test.ts::14. limiting comparison: sign is postLimit - preLimit | FAIL | expected -1 to be greater than or equal to 0 |
| pw:gui/analog-bjt-convergence.spec.ts::compile and step — no convergence error, supply rail is 10V | FAIL | Expected 0.018960433572457643 to be close to 0.02084652 |
| pw:gui/analog-bjt-convergence.spec.ts::step to 5ms — output voltage evolves and trace captures transient | FAIL | toBeCloseTo precision |
| pw:gui/component-sweep.spec.ts::DAC at bits=4: set property and compile | FAIL | Status bar shows an error |
| pw:gui/component-sweep.spec.ts::DAC at bits=8: set property and compile | FAIL | Status bar shows an error |
| pw:gui/component-sweep.spec.ts::ADC at bits=4: set property and compile | FAIL | Status bar shows an error |
| pw:gui/component-sweep.spec.ts::ADC at bits=8: set property and compile | FAIL | Status bar shows an error |
| pw:gui/master-circuit-assembly.spec.ts::Master 1: digital logic — gates, flip-flop, counter | FAIL | Status bar shows an error |
| pw:gui/hotload-params-e2e.spec.ts::changing BF on BJT via primary param row changes output voltage | FAIL | Expected 0.09577162816208763 to be close to 0.0957744513 |
| pw:gui/master-circuit-assembly.spec.ts::Master 2: analog — switched divider, RC, opamp, BJT | FAIL | toBeLessThan |
| pw:gui/master-circuit-assembly.spec.ts::Master 3: mixed-signal — DAC, RC, comparator, counter | FAIL | toBeVisible failed |
| pw:gui/stepping-perf.spec.ts::buckbjt at 1ms/s — simTime advances at least 500us in 2s wall time | FAIL | simTime only advanced 0.0us — expected at least 500us |
| pw:gui/stepping-perf.spec.ts::buckbjt fast-forward 1ms — completes within 5s wall budget | FAIL | FF only advanced 0.0us — expected ~1ms |

Per the TESTS-RED PROTOCOL in `spec/plan.md`, this baseline is far from green and full-suite passage is **NOT** a phase gate. Implementers run targeted vitest commands scoped to modified files. Implementers and verifiers should consult this baseline before investigating any test failure to confirm whether it is pre-existing or caused by their changes.
