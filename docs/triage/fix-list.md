# Fix worklist

86 distinct fixes covering 225 failing tests (from root-cause-inventory.jsonl). Sorted by expected test payoff.

- engine-fix items: 72 (cover 187 tests)
- escalate / test-design / test-fixture / test-arch items: 14

## 1. [engine-fix] Composite-leaf givenness: expandCompositeInstance marks leaf-model DEFAULT params as given (setModelParam) -> use markGiven:false. Agents flagged optocoupler.ts:54 and the diac diode.ts:913 0-step failures as the SAME cause (verify by re-run after the compiler fix).

- **Root cause:** `src/solver/analog/compiler.ts:517, src/components/active/optocoupler.ts:54, src/components/semiconductors/diode.ts:913`
- **Expected to fix:** 49 test(s) · confidence high
- **Diagnosis:** Composite expansion copies every leaf-model DEFAULT param into subProps via setModelParam, which marks it as user-given. For the phototransistor BJT spice model this marks RCO (default 0.01) as given, so bjt.ts:1549 rcoGiven becomes true an
- **Fix hint:** Do not mark leaf-default model params as given during composite expansion. Use a non-given default-seeding path so isModelParamGiven only reports params explicitly set in the netlist or by the user, matching standalone placement.
- **Tests:**
  - [ ] `src/components/active/__tests__/optocoupler-cccs.test.ts` — init_active_anode_and_collector_finite
  - [ ] `src/components/active/__tests__/optocoupler-cccs.test.ts` — dcop_photocurrent_couples_through_phototransistor_collector
  - [ ] `src/components/active/__tests__/optocoupler-cccs.test.ts` — dcop_paired_active
  - [ ] `src/components/active/__tests__/optocoupler-cccs.test.ts` — dcop_paired_low
  - [ ] `src/components/active/__tests__/optocoupler-cccs.test.ts` — hotload_ctr_changes_collector_voltage
  - [ ] `src/components/active/__tests__/optocoupler-cccs.test.ts` — limiting_events_recorded_during_dcop
  - [ ] `src/components/active/__tests__/optocoupler.test.ts` — dcop_photocurrent_couples_through_phototransistor_collector
  - [ ] `src/components/active/__tests__/optocoupler.test.ts` — dcop_paired_active
  - [ ] `src/components/active/__tests__/optocoupler.test.ts` — dcop_paired_low
  - [ ] `src/components/active/__tests__/optocoupler.test.ts` — limiting_events_recorded_during_dcop
  - [ ] `src/components/active/__tests__/optocoupler.test.ts` — init_active_anode_below_rail_collector_below_rail
  - [ ] `src/components/active/__tests__/optocoupler.test.ts` — hotload_ctr_lowers_collector_voltage
  - [ ] `src/components/active/__tests__/optocoupler.test.ts` — hotload_Is_raises_led_current_lowers_anode_voltage
  - [ ] `src/components/active/__tests__/optocoupler.test.ts` — hotload_n_changes_led_anode_voltage
  - [ ] `src/components/semiconductors/__tests__/diac.test.ts` — init_blocking_node_voltage_near_zero
  - [ ] `src/components/semiconductors/__tests__/diac.test.ts` — init_blocking_anode_voltage_tracks_source
  - [ ] `src/components/semiconductors/__tests__/diac.test.ts` — dcop_blocking_current_below_one_milliamp
  - [ ] `src/components/semiconductors/__tests__/diac.test.ts` — dcop_breakover_conducts_above_threshold
  - [ ] `src/components/semiconductors/__tests__/diac.test.ts` — dcop_breakover_symmetric_under_polarity_flip
  - [ ] `src/components/semiconductors/__tests__/diac.test.ts` — dcop_paired_blocking
  - [ ] `src/components/semiconductors/__tests__/diac.test.ts` — dcop_paired_breakover
  - [ ] `src/components/semiconductors/__tests__/scr.test.ts` — limiting_pnjlim_fires_on_q1_or_q2_junction_during_dcop
  - [ ] `src/components/semiconductors/__tests__/scr.test.ts` — dcop_paired_blocking
  - [ ] `src/components/semiconductors/__tests__/scr.test.ts` — dcop_paired_triggered
  - [ ] `src/components/semiconductors/__tests__/scr.test.ts` — dcop_triggered_anode_voltage_drops_when_gate_biased
  - [ ] `src/components/semiconductors/__tests__/scr.test.ts` — dcop_blocking_vs_triggered_anode_current_ordering
  - [ ] `src/components/semiconductors/__tests__/triac.test.ts` — dcop_paired_blocking
  - [ ] `src/components/semiconductors/__tests__/triac.test.ts` — dcop_paired_gated_on
  - [ ] `src/components/semiconductors/__tests__/triac.test.ts` — dcop_paired_reverse_blocking
  - [ ] `src/components/semiconductors/__tests__/triac.test.ts` — dcop_gated_on_conducts
  - [ ] `src/components/semiconductors/__tests__/triac.test.ts` — hotload_BF_changes_blocking_anode_voltage
  - [ ] `src/components/semiconductors/__tests__/triac.test.ts` — hotload_TEMP_changes_blocking_anode_voltage
  - [ ] `src/components/semiconductors/__tests__/triac.test.ts` — hotload_AREA_changes_blocking_anode_voltage
  - [ ] `src/components/semiconductors/__tests__/triac.test.ts` — hotload_IS_changes_blocking_anode_voltage
  - [ ] `src/components/semiconductors/__tests__/triac.test.ts` — hotload_BR_changes_blocking_anode_voltage
  - [ ] `src/solver/analog/__tests__/harness/comparison-session-asserts.ts` — full_iteration_paired_active
  - [ ] `src/solver/analog/__tests__/harness/comparison-session-asserts.ts` — full_iteration_paired_low
  - [ ] `src/solver/analog/__tests__/harness/comparison-session-asserts.ts` — full_iteration_paired_blocking
  - [ ] `src/solver/analog/__tests__/harness/comparison-session-asserts.ts` — transient_step_end_paired_blocking
  - [ ] `src/solver/analog/__tests__/harness/comparison-session-asserts.ts` — transient_step_end_paired_breakover
  - [ ] `src/solver/analog/__tests__/harness/comparison-session-asserts.ts` — transient_step_end_paired_active
  - [ ] `src/solver/analog/__tests__/harness/comparison-session-asserts.ts` — transient_step_end_paired_low
  - [ ] `src/solver/analog/__tests__/harness/comparison-session-asserts.ts` — full_iteration_paired_triggered
  - [ ] `src/solver/analog/__tests__/harness/comparison-session-asserts.ts` — full_iteration_paired_gated_on
  - [ ] `src/solver/analog/__tests__/harness/comparison-session-asserts.ts` — full_iteration_paired_reverse_blocking
  - [ ] `src/solver/analog/__tests__/harness/comparison-session.ts` — transient_step_end_paired_blocking
  - [ ] `src/solver/analog/__tests__/harness/comparison-session.ts` — transient_step_end_paired_triggered
  - [ ] `src/solver/analog/__tests__/harness/comparison-session.ts` — transient_step_end_paired_gated_on
  - [ ] `src/solver/analog/__tests__/harness/comparison-session.ts` — transient_step_end_paired_reverse_blocking

## 2. [engine-fix] DigitalInputThresholder classifies with a CMOS dead-band (vIH=2.0 vIL=0.8 defaults at lines 61-62 fed from and

- **Root cause:** `src/solver/analog/behavioral-drivers/digital-input-thresholder.ts:73`
- **Expected to fix:** 8 test(s) · confidence high
- **Fix hint:** Replace the three-way dead-band classifier with a single midpoint comparison v > 0.5 ? 1.0 : 0.0 (normalized {0,1} contract) and drop the vIH/vIL dead-band defaults; or set gate input thresholds to the normalized midpoint so 1.5V classifies
- **Tests:**
  - [ ] `src/solver/analog/behavioral-drivers/__tests__/gate-driver-ctrl-stamp.test.ts` — treats above-threshold input as HIGH (A=MID, B=MID): AND -> HI
  - [ ] `src/solver/analog/behavioral-drivers/__tests__/gate-driver-ctrl-stamp.test.ts` — treats above-threshold input as HIGH (A=MID, B=MID): OR -> HI
  - [ ] `src/solver/analog/behavioral-drivers/__tests__/gate-driver-ctrl-stamp.test.ts` — treats above-threshold input as HIGH (A=MID, B=MID): XNOR -> HI (equal)
  - [ ] `src/solver/analog/behavioral-drivers/__tests__/gate-driver-ctrl-stamp.test.ts` — treats above-threshold input as HIGH (In_1=MID): BUF -> HI
  - [ ] `src/solver/analog/behavioral-drivers/__tests__/gate-driver-ctrl-stamp.test.ts` — treats above-threshold input as HIGH (A=MID, B=MID): NAND -> LO
  - [ ] `src/solver/analog/behavioral-drivers/__tests__/gate-driver-ctrl-stamp.test.ts` — treats above-threshold input as HIGH (A=MID, B=MID): NOR -> LO
  - [ ] `src/solver/analog/behavioral-drivers/__tests__/gate-driver-ctrl-stamp.test.ts` — treats above-threshold input as HIGH (A=MID, B=MID): XOR -> LO (equal)
  - [ ] `src/solver/analog/behavioral-drivers/__tests__/gate-driver-ctrl-stamp.test.ts` — treats above-threshold input as HIGH (in=MID): NOT -> LO

## 3. [engine-fix] Drivers stamp rail-level vTarget onto ctrl_out but DigitalOutputPinLoaded re-applies rail span -> stamp normalized [0,1] level

- **Root cause:** `src/components/active/comparator-driver.ts:193, src/components/active/comparator-pushpull-driver.ts:170, src/components/active/timer-555-latch-driver.ts:129`
- **Expected to fix:** 8 test(s) · confidence high
- **Diagnosis:** ComparatorDriver stamps a RAIL-LEVEL Thevenin target vTarget = (1-w)*vOH + w*vOL onto the internal ctrl_out net, but the downstream DigitalOutputPinLoaded.outPin expects ctrl in NORMALIZED [0,1] V (digital-output-pin-loaded.ts:8-11) and re-
- **Fix hint:** The driver must stamp the NORMALIZED logic level onto ctrl_out, not the rail-level vTarget. With latch=0 inactive the logic level is 1 (-> outPin drives vOH) and latch=1 active is 0 (-> vOL), so stamp (1 - wForStamp) as the ctrl target at l
- **Tests:**
  - [ ] `src/components/active/__tests__/comparator-rollback.test.ts` — dcop_oc_off_output_near_voh
  - [ ] `src/components/active/__tests__/comparator-rollback.test.ts` — dcop_pp_off_output_near_voh
  - [ ] `src/components/active/__tests__/comparator-rollback.test.ts` — hotload_responseTime_faster_integration_lowers_output_sooner
  - [ ] `src/components/active/__tests__/comparator-rollback.test.ts` — hotload_hysteresis_flips_latch_when_margin_inside_dead_band
  - [ ] `src/components/active/__tests__/comparator-rollback.test.ts` — hotload_vos_shifts_threshold_above_input_flips_latch
  - [ ] `src/components/active/__tests__/timer-555-debug.test.ts` — hotload_vOH_changes_output_voltage_when_high
  - [ ] `src/components/active/__tests__/timer-555-debug.test.ts` — hotload_vOL_changes_output_voltage_when_low
  - [ ] `src/components/active/__tests__/timer-555.test.ts` — hotload_vOH_changes_output_high_voltage

## 4. [engine-fix] RealOpAmp rail saturation never forms a converged fixed point (Jacobian swap vs railLim bisection)

- **Root cause:** `src/components/active/real-opamp.ts:541, src/components/active/real-opamp.ts:485`
- **Expected to fix:** 7 test(s) · confidence high
- **Diagnosis:** Duplicate of the other full_iteration_paired_rail_saturation record (same RealOpAmp session). RealOpAmp rail-saturation DCOP errors at step 0 (dt=0 iters=101 converged=false per convergence log) so 0 comparable steps. Root cause is the disc
- **Fix hint:** Same fix as the sibling record: replace the hard RHS-branch switch at real-opamp.ts:541-556 with a continuous-Jacobian rail-saturation linearization so the DCOP converges.
- **Tests:**
  - [ ] `src/components/active/__tests__/real-opamp-raillim.test.ts` — dcop_rail_saturation_clamps_to_vrail_pos
  - [ ] `src/components/active/__tests__/real-opamp-raillim.test.ts` — hotload_vSatPos_shifts_rail_clamp
  - [ ] `src/components/active/__tests__/real-opamp-raillim.test.ts` — limiting_railLim_engaged_under_overdrive
  - [ ] `src/components/active/__tests__/real-opamp.test.ts` — init_rail_sat_state_out_sat_flag_set
  - [ ] `src/solver/analog/__tests__/harness/comparison-session-asserts.ts` — full_iteration_paired_rail_saturation
  - [ ] `src/solver/analog/__tests__/harness/comparison-session-asserts.ts` — transient_step_end_paired_rail_saturation
  - [ ] `src/solver/analog/__tests__/harness/comparison-session.ts` — dcop_paired_rail_saturation

## 5. [escalate] Bit-exact mismatch: cktTerrVoltage uses GEAR_LTE_FACTORS[1]=0.2222222222 (truncated decimal, matches ngspice c

- **Root cause:** `src/solver/analog/ckt-terr.ts:53`
- **Expected to fix:** 6 test(s) · confidence high
- **Fix hint:** Source line 53 already matches ngspice cktterr.c:25 truncated literal. The test factor 2/9 at test line 233 is the divergent value; per SPICE-correct rule the test reference should use 0.2222222222 not 2/9. Escalate: test encodes non-ngspic
- **Tests:**
  - [ ] `src/solver/analog/__tests__/ckt-terr.test.ts` — order 2 gear: applies sqrt root extraction for nonzero 3rd divided difference
  - [ ] `src/solver/analog/__tests__/ckt-terr.test.ts` — trapezoidal order 2 and gear order 2 both return positive finite timestep for cubic data
  - [ ] `src/solver/analog/__tests__/ckt-terr.test.ts` — gear_lte_factor_order_3
  - [ ] `src/solver/analog/__tests__/ckt-terr.test.ts` — gear_lte_factor_order_5
  - [ ] `src/solver/analog/__tests__/ckt-terr.test.ts` — gear_lte_factor_order_6
  - [ ] `src/solver/analog/__tests__/ckt-terr.test.ts` — cktTerrVoltage_gear_order2_matches_ngspice

## 6. [engine-fix] Hotload test asserts the pure resistive divider vOH*RLOAD/(rOut+RLOAD) but coordinator.step() runs a TRANSIENT

- **Root cause:** `src/components/digital-pins/digital-output-pin-loaded.ts:99`
- **Expected to fix:** 6 test(s) · confidence medium
- **Fix hint:** Either re-settle to DCOP after setComponentProperty (zero out cOut companion) before reading, or have the test compare against the transient-loaded divider including cOut companion; the source-side cOut companion is in-circuit during step()
- **Tests:**
  - [ ] `src/solver/analog/__tests__/behavioral-combinational.test.ts` — hotload_vOH_changes_output_high_voltage
  - [ ] `src/solver/analog/__tests__/behavioral-combinational.test.ts` — hotload_vOH_changes_selected_output_voltage
  - [ ] `src/solver/analog/__tests__/behavioral-combinational.test.ts` — hotload_vOH_changes_active_output_voltage
  - [ ] `src/solver/analog/__tests__/behavioral-combinational.test.ts` — hotload_rOut_changes_output_divider_voltage
  - [ ] `src/solver/analog/__tests__/behavioral-combinational.test.ts` — hotload_rOut_changes_selected_output_divider
  - [ ] `src/solver/analog/__tests__/behavioral-combinational.test.ts` — hotload_rOut_changes_active_output_divider

## 7. [engine-fix] BehavioralFETDriver.load classifies on a hard discontinuous threshold on vGS=V(G)-V(S); in a source-follower V

- **Root cause:** `src/components/switching/behavioral-fet-driver.ts:135`
- **Expected to fix:** 6 test(s) · confidence high
- **Fix hint:** Classify the gate logic level on V(G) against a fixed logic reference (or add hysteresis/continuation smoothing) instead of the source-relative vGS so the source-follower feedback does not create a bistable discontinuity.
- **Tests:**
  - [ ] `src/components/switching/__tests__/fets.test.ts` — dcop_gate_on_drives_v_s_near_vs
  - [ ] `src/components/switching/__tests__/fets.test.ts` — init_post_warm_start_node_voltage_pass_through_seed
  - [ ] `src/components/switching/__tests__/fets.test.ts` — hotload_Ron_drops_v_s_under_load
  - [ ] `src/components/switching/__tests__/fets.test.ts` — hotload_Vth_above_gate_drive_isolates_channel
  - [ ] `src/components/switching/__tests__/fets.test.ts` — dcop_gate_low_drives_v_s_near_vs
  - [ ] `src/components/switching/__tests__/fets.test.ts` — hotload_Vth_inverts_channel_state

## 8. [test-fixture] All 1000 trials report failedTrials. The test fixtures build ConcreteCompiledAnalogCircuit with elementsByFami

- **Root cause:** `src/solver/analog/ckt-load.ts:127`
- **Expected to fix:** 5 test(s) · confidence high
- **Fix hint:** The load path is family-bucket driven (runByDeviceFamily over elementsByFamily); the hand-built fixtures must populate elementsByFamily from the elements array (group by deviceFamily as compiler.ts:1509-1515 does) instead of passing new Map
- **Tests:**
  - [ ] `src/solver/analog/__tests__/monte-carlo.test.ts` — gaussian_distribution
  - [ ] `src/solver/analog/__tests__/monte-carlo.test.ts` — output_statistics
  - [ ] `src/solver/analog/__tests__/monte-carlo.test.ts` — linear_sweep
  - [ ] `src/solver/analog/__tests__/monte-carlo.test.ts` — ac_sweep_at_each_value
  - [ ] `src/solver/analog/__tests__/monte-carlo.test.ts` — log_sweep

## 9. [engine-fix] Transformer (two coupled inductors LTX1_L1/LTX1_L2 plus mutual) driven by V1 with R_LOAD on the secondary. Our

- **Root cause:** `src/solver/analog/dc-operating-point.ts:496`
- **Expected to fix:** 5 test(s) · confidence medium
- **Fix hint:** Enable/repair the OPtran pseudo-transient fallback (dc-operating-point.ts lines 496-521 gated by params.optran and ctx.opTranFallback) so the transformer DC-OP branch-current singularity is resolved the way ngspice cktop.c OPtran does. Veri
- **Tests:**
  - [ ] `src/components/passives/__tests__/tapped-transformer.test.ts` — full_iteration_paired_ac_sinusoid
  - [ ] `src/components/passives/__tests__/transformer.test.ts` — full_iteration_paired_ac_step_down
  - [ ] `src/components/passives/__tests__/transformer.test.ts` — transient_temp_sweep_300_15K_paired
  - [ ] `src/components/passives/__tests__/transformer.test.ts` — transient_temp_sweep_350K_paired
  - [ ] `src/components/passives/__tests__/transformer.test.ts` — transient_temp_sweep_400K_paired

## 10. [engine-fix] Schmitt netlist maps rOut Resistor with key R (caps with C) but Resistor/Capacitor keys are resistance/capacitance -> mapping never binds, rOut defaults to 1000

- **Root cause:** `src/components/active/schmitt-trigger.ts:83, src/components/active/schmitt-trigger.ts:63`
- **Expected to fix:** 5 test(s) · confidence high
- **Diagnosis:** rOut Resistor sub-element maps params {R: rOut} but the Resistor param key is resistance not R; the mapping never binds so the resistor defaults to 1000 ohm. st:out becomes 3.3*10000/11000.001=2.9999997 instead of 3.3*10000/10050=3.284, so 
- **Fix hint:** Change the rOut sub-element param map from {R: rOut} to {resistance: rOut} in SCHMITT_NON_INVERTING_NETLIST (and SCHMITT_INVERTING_NETLIST line 63); also fix the cIn/cOut maps from C to capacitance.
- **Tests:**
  - [ ] `src/components/active/__tests__/schmitt-trigger.test.ts` — init_noninv_high_input_latch_one
  - [ ] `src/components/active/__tests__/schmitt-trigger.test.ts` — init_inv_low_input_output_high
  - [ ] `src/components/active/__tests__/schmitt-trigger.test.ts` — hotload_vTL_shifts_falling_threshold
  - [ ] `src/components/active/__tests__/schmitt-trigger.test.ts` — dcop_noninv_high_output_near_voh
  - [ ] `src/components/active/__tests__/schmitt-trigger.test.ts` — dcop_inv_low_output_near_voh

## 11. [engine-fix] CORRECTION (supersedes prior medium record): direct probe confirms load() recomputes the latch and writes s0[C

- **Root cause:** `src/components/sensors/spark-gap.ts:226`
- **Expected to fix:** 4 test(s) · confidence high
- **Fix hint:** Make the CONDUCTING slot written to s0 in load() reach state1 each accepted step (boot DCOP seeds s1 so init tests pass; the transient per-step commit does not). Ensure rotation/seed carries this latch slot so conductingOld (s1) at line 206
- **Tests:**
  - [ ] `src/components/sensors/__tests__/spark-gap-rollback.test.ts` — hotload_iHold_above_steady_current_extinguishes_gap
  - [ ] `src/components/sensors/__tests__/spark-gap-rollback.test.ts` — hotload_vBreakdown_lower_below_source_fires_gap
  - [ ] `src/components/sensors/__tests__/spark-gap.test.ts` — hotload_iHold_raise_above_steady_current_extinguishes_gap
  - [ ] `src/components/sensors/__tests__/spark-gap.test.ts` — hotload_vBreakdown_drop_below_vsrc_fires_blocking_gap

## 12. [engine-fix] QuartzCrystal is a kind:netlist composite. buildCrystalNetlist derives Ls and Rs from frequency/qualityFactor/

- **Root cause:** `src/components/passives/crystal.ts:195`
- **Expected to fix:** 4 test(s) · confidence high
- **Fix hint:** Add a setParam path on the composite that recomputes Ls/Rs (crystalMotionalInductance/crystalSeriesResistance) and delegates resistance/inductance/capacitance into the rS/lS/cS/c0 leaves on hot-load.
- **Tests:**
  - [ ] `src/components/passives/__tests__/crystal.test.ts` — hotload_frequency_changes_transient_response
  - [ ] `src/components/passives/__tests__/crystal.test.ts` — hotload_qualityFactor_changes_transient_response
  - [ ] `src/components/passives/__tests__/crystal.test.ts` — hotload_motionalCapacitance_changes_transient_response
  - [ ] `src/components/passives/__tests__/crystal.test.ts` — hotload_shuntCapacitance_changes_transient_response

## 13. [engine-fix] setComponentProperty(st, vTH, 1.0) on a composite resolves via the elementToCircuitElement reverse map which c

- **Root cause:** `src/solver/coordinator.ts:716`
- **Expected to fix:** 4 test(s) · confidence high
- **Fix hint:** Composite param hot-load must fan out to every compiled sub-element of the CircuitElement (build a one-to-many map) and route plain model-param keys to the driver sub-element, not just the last-iterated one; also fix schmitt rOut mapping (s
- **Tests:**
  - [ ] `src/components/active/__tests__/schmitt-trigger.test.ts` — hotload_vTH_shifts_rising_threshold
  - [ ] `src/components/active/__tests__/schmitt-trigger.test.ts` — hotload_vOH_changes_output_high_level
  - [ ] `src/components/active/__tests__/schmitt-trigger.test.ts` — hotload_vOL_changes_output_low_level
  - [ ] `src/components/active/__tests__/schmitt-trigger.test.ts` — hotload_rOut_changes_output_divider

## 14. [test-design] Test reads getElementPinCurrents on the cap:cBody Capacitor leaf expecting the DC leakage current V/(esr+rLeak

- **Root cause:** `src/components/passives/capacitor.ts:641`
- **Expected to fix:** 4 test(s) · confidence high
- **Fix hint:** Test targets wrong leaf: probe cap:rLeak (or cap:rEsr) for DC series current, not cap:cBody. Source is correct; if a total-component current is wanted, read it off the wrapper or a resistive leaf.
- **Tests:**
  - [ ] `src/components/passives/__tests__/polarized-cap.test.ts` — dcop_dc_current_through_cap_equals_v_over_esr_plus_rleak
  - [ ] `src/components/passives/__tests__/polarized-cap.test.ts` — hotload_leakageCurrent_changes_dc_steady_state_current
  - [ ] `src/components/passives/__tests__/polarized-cap.test.ts` — hotload_voltageRating_changes_dc_steady_state_current
  - [ ] `src/components/passives/__tests__/polarized-cap.test.ts` — hotload_M_scales_dc_steady_state_current

## 15. [engine-fix] Inverted comparator latch polarity (sink when V+>V- instead of V+<V-)

- **Root cause:** `src/components/active/comparator-driver.ts:165, src/components/active/comparator-pushpull-driver.ts:146`
- **Expected to fix:** 4 test(s) · confidence high
- **Diagnosis:** Open-collector comparator latch polarity is inverted: latch=1 (active/sinking, drives vOL/LOW) is set when vPlus >= vTh i.e. when in+ is ABOVE in-, but a comparator drives output HIGH when V+ > V-. So in+ above in- wrongly sinks the output 
- **Fix hint:** Invert the latch transition conditions at lines 165-166: latch should go to 1 (sinking) when vPlus < vTl and release to 0 when vPlus >= vTh, so V+>V- yields not-sinking (HIGH) and V+<V- yields sinking (LOW).
- **Tests:**
  - [ ] `src/components/active/__tests__/component-local-driver-ctrl-stamp.test.ts` — stamps vOH at out when in+ is above in- (not sinking: pull-up holds line high)
  - [ ] `src/components/active/__tests__/component-local-driver-ctrl-stamp.test.ts` — stamps vOL at out when in+ is below in- (asserted: sinking pulls line low)
  - [ ] `src/components/active/__tests__/component-local-driver-ctrl-stamp.test.ts` — stamps vOH at out when in+ is above in- (push-pull drives HIGH)
  - [ ] `src/components/active/__tests__/component-local-driver-ctrl-stamp.test.ts` — stamps vOL at out when in+ is below in- (push-pull drives LOW)

## 16. [engine-fix] Test sets vos=0.5 then steps 5 times (transient) and expects unity-follower Vout to shift by ~0.5V; actual shi

- **Root cause:** `src/components/active/real-opamp.ts:553`
- **Expected to fix:** 3 test(s) · confidence medium
- **Fix hint:** In the transient gain-stage the vos offset must propagate through the same loop gain as the steady-state DC path; the line-555 RHS uses aEff (bandwidth-reduced) for vos rather than the integrator-mediated full offset, so the 5-step transien
- **Tests:**
  - [ ] `src/components/active/__tests__/real-opamp-raillim.test.ts` — hotload_vos_shifts_unity_follower_output
  - [ ] `src/components/active/__tests__/real-opamp.test.ts` — hotload_aol_changes_inverting_gain_error
  - [ ] `src/components/active/__tests__/real-opamp.test.ts` — preset_OPA2134_shifts_dc_output_by_vos_delta

## 17. [test-fixture] The non-engine coordinator stub initializes nextSnapshotId to 1 and saveSnapshot returns 1-based IDs (1,2,3), 

- **Root cause:** `src/test-utils/non-engine-coordinator.ts:126`
- **Expected to fix:** 3 test(s) · confidence high
- **Fix hint:** Change non-engine-coordinator.ts line 126 from let nextSnapshotId = 1 to let nextSnapshotId = 0 to match DigitalEngine 0-based snapshot IDs.
- **Tests:**
  - [ ] `src/runtime/__tests__/timing-diagram.test.ts` — snapshot IDs match what the coordinator returned
  - [ ] `src/runtime/__tests__/timing-diagram.test.ts` — restores the closest snapshot to time 0 when jumped to start
  - [ ] `src/runtime/__tests__/timing-diagram.test.ts` — restores the closest snapshot when jumpToTime is called

## 18. [engine-fix] Transient at step 0 our engine stalls (1 step then dt=0) while ngspice advances 107 steps. harness_first_diver

- **Root cause:** `src/solver/analog/dc-operating-point.ts:403`
- **Expected to fix:** 3 test(s) · confidence medium
- **Fix hint:** Compare our dynamicGmin-to-newGmin fallthrough and gillespieSrc backtracking attempt sequence against ngspice cktop.c dynamic_gmin/gillespie_src so our step-0 transient OP runs the same number of sub-attempts and converges to the same point
- **Tests:**
  - [ ] `src/components/semiconductors/__tests__/bjt-canon-temp-sweep.test.ts` — temp_300_15K_compareAllAttempts
  - [ ] `src/components/semiconductors/__tests__/bjt-canon-temp-sweep.test.ts` — temp_350K_compareAllAttempts
  - [ ] `src/components/semiconductors/__tests__/bjt-canon-temp-sweep.test.ts` — temp_400K_compareAllAttempts

## 19. [test-design] buildFixture warm-start runs DCOP plus one transient step (build-fixture.ts:137 then engine first step). In th

- **Root cause:** `src/components/passives/memristor.ts:259`
- **Expected to fix:** 3 test(s) · confidence high
- **Fix hint:** Assert the seed against fix.pool.state1[mem._stateBase+SLOT_W] (last-accepted, pre-first-step) instead of state0[W], or relax to verify state0[W] is the seed plus exactly one integration step. The source line 259 is correct ngspice CKTstate
- **Tests:**
  - [ ] `src/components/passives/__tests__/memristor-rollback.test.ts` — init_w_seeded_to_initialState_after_warm_start
  - [ ] `src/components/passives/__tests__/memristor.test.ts` — init_w_slot_seeded_from_initial_state_mid
  - [ ] `src/components/passives/__tests__/memristor.test.ts` — init_w_slot_seeded_from_initial_state_edge

## 20. [escalate] polarizedcap-canon-reverse-bias: both engines run 107 identical steps; the only divergence is a 1-ULP value-on

- **Root cause:** `src/components/passives/polarized-cap.ts:207`
- **Expected to fix:** 2 test(s) · confidence high
- **Fix hint:** Align the leaf stamp accumulation order on the nCap diagonal with ngspice. The leaf order in POLARIZED_CAP_NETLIST_BUILDER elements[] (polarized-cap.ts:207-235) is rEsr,rLeak,cBody; the compiler reverse-sorts within bucket (compiler.ts:1465
- **Tests:**
  - [ ] `src/solver/analog/__tests__/harness/comparison-session-asserts.ts` — transient_step_end_paired_reverse_bias
  - [ ] `src/solver/analog/__tests__/harness/comparison-session-asserts.ts` — full_iteration_paired_reverse_bias

## 21. [engine-fix] tapped-transformer-canon-ac-sinusoid: our engine does not advance past step 0 (harness: ours 1 step / 49 NR it

- **Root cause:** `src/components/passives/inductor.ts:891`
- **Expected to fix:** 2 test(s) · confidence medium
- **Fix hint:** Investigate why the transient timestep never advances for coupled inductors (MutualInductor + 3 Inductors): the engine accepts only the t=0 step then stops. Check the first-transient-dt handoff in analog-engine.ts step loop / timestep.getCl
- **Tests:**
  - [ ] `src/solver/analog/__tests__/harness/comparison-session-asserts.ts` — transient_step_end_paired_ac_sinusoid
  - [ ] `src/solver/analog/__tests__/harness/comparison-session-asserts.ts` — transient_step_end_paired_ac_step_down

## 22. [engine-fix] cktTerr returns Infinity early when ddiff===0 (linear charge history), bypassing ngspice cktterr.c:69 MAX(abst

- **Root cause:** `src/solver/analog/ckt-terr.ts:190`
- **Expected to fix:** 2 test(s) · confidence high
- **Fix hint:** Delete the line 190 early return; let denom=Math.max(abstol, factor*ddiff) clamp to abstol when ddiff===0, matching cktterr.c:69, then return del per order.
- **Tests:**
  - [ ] `src/solver/analog/__tests__/ckt-terr.test.ts` — order 1 trapezoidal: returns finite positive timestep for non-trivial charges
  - [ ] `src/solver/analog/__tests__/ckt-terr.test.ts` — constant charge history produces finite timestep (not Infinity)- abstol-gated

## 23. [engine-fix] Unity follower Vout reads 2.00098 not ~2.00000. buildUnityFollower (test line 45) passes no vos so the model d

- **Root cause:** `src/components/active/real-opamp.ts:170`
- **Expected to fix:** 2 test(s) · confidence high
- **Fix hint:** Either the param default vos at real-opamp.ts:170 (1e-3) is non-zero while the test fixture assumes 0, or the gain-stage vos term at line 555 should not be applied at this magnitude; reconcile the default vos with the unity-follower closed-
- **Tests:**
  - [ ] `src/components/active/__tests__/real-opamp-raillim.test.ts` — dcop_unity_follower_tracks_vin
  - [ ] `src/components/active/__tests__/real-opamp-raillim.test.ts` — hotload_aol_shifts_finite_gain_error

## 24. [engine-fix] The RS series-resistance internal prime node is allocated only when RS != 0 and only at setup() time (diode.ts

- **Root cause:** `src/components/semiconductors/diode.ts:839`
- **Expected to fix:** 2 test(s) · confidence high
- **Fix hint:** Always allocate the RS internal prime node at setup() regardless of RS value (or re-run topology setup on RS hot-load), so a nonzero RS loaded later actually inserts the series drop. Match diosetup.c node creation but make it unconditional 
- **Tests:**
  - [ ] `src/components/semiconductors/__tests__/diode.test.ts` — hotload_RS_changes_vd
  - [ ] `src/components/semiconductors/__tests__/varactor.test.ts` — hotload_RS_changes_anode_voltage_forward

## 25. [engine-fix] _computeZenerTp (zener.ts:230-248) recomputes the temperature-scaled thermal voltages vt nVt nbvVt and tBV but

- **Root cause:** `src/components/semiconductors/zener.ts:230`
- **Expected to fix:** 2 test(s) · confidence high
- **Fix hint:** Add a tIS (DIOtSatCur) derivation to _computeZenerTp mirroring diotemp.c:175-185 (scale IS by exp((T/TNOM-1)*EG/vt)*(T/TNOM)^(XTI/N)) and use tIS instead of params.IS everywhere current/conductance is computed in load() (zener.ts:309 314 31
- **Tests:**
  - [ ] `src/components/semiconductors/__tests__/zener.test.ts` — hotload_TEMP_changes_vf_forward
  - [ ] `src/components/semiconductors/__tests__/zener.test.ts` — computeTemperature_ambient_propagates_to_vf

## 26. [test-arch] TransGateDefinition lacks pairedSpiceEquivalent:false. Its behavioral model (BehavioralFETDriver Norton ctrl r

- **Root cause:** `src/components/switching/trans-gate.ts:337`
- **Expected to fix:** 2 test(s) · confidence high
- **Fix hint:** Mark TransGateDefinition pairedSpiceEquivalent:false (like fuse/opamp/ota) and switch these tests from ComparisonSession.create (T3 paired) to createSelfCompare (T2). The numeric stamp at fet-sw.ts:127 is correct; the on-conductance simply 
- **Tests:**
  - [ ] `src/solver/analog/__tests__/harness/comparison-session-asserts.ts` — full_iteration_paired_pass_through
  - [ ] `src/solver/analog/__tests__/harness/comparison-session-asserts.ts` — full_iteration_paired_isolation

## 27. [test-design] Test expects the loaded sel pin to sag below 4.7V via rIn approx 100k in series with a 10k source resistor, bu

- **Root cause:** `src/components/digital-pins/digital-input-pin-loaded.ts:13`
- **Expected to fix:** 2 test(s) · confidence high
- **Fix hint:** Reconcile rIn default: either the source default should be 100k or the test must assert the 1MOhm sag (approx 4.9505); the loaded vs unloaded contrast also fails because unloaded has no rIn so both read near 5V. User disposition required on
- **Tests:**
  - [ ] `src/solver/analog/__tests__/behavioral-combinational.test.ts` — hotload_loaded_structural_property_seeds_pin_subelements
  - [ ] `src/solver/analog/__tests__/behavioral-combinational.test.ts` — loaded_sel_pin_sags_through_external_series_resistor

## 28. [test-design] For the spice-l1 fixture GAMMA defaults to 0 and the body is tied to source (vbs=0, setup line 909). With GAMM

- **Root cause:** `src/components/semiconductors/mosfet.ts:1375`
- **Expected to fix:** 2 test(s) · confidence high
- **Fix hint:** Source is ngspice-correct (mos1load.c von formula). The test needs a fixture with nonzero GAMMA and a nonzero Vbs so PHI feeds the body-effect term; otherwise PHI has no OP effect. No source line change is correct.
- **Tests:**
  - [ ] `src/components/semiconductors/__tests__/mosfet.test.ts` — hotload_PHI_changes_vd
  - [ ] `src/components/semiconductors/__tests__/mosfet.test.ts` — hotload_GAMMA_changes_vd

## 29. [engine-fix] Behavioral AND netlist selects input-pin loading from the static model param loaded (and.ts:196) and a single 

- **Root cause:** `src/components/gates/and.ts:196`
- **Expected to fix:** 2 test(s) · confidence high
- **Fix hint:** Have buildAndGateNetlist read the per-pin loaded flag and per-pin ResolvedPinElectrical (the _pinLoading / _pinElectrical maps set on props by compiler.ts) when choosing DigitalInputPinLoaded vs Unloaded and the rIn value per In_i, instead 
- **Tests:**
  - [ ] `src/solver/analog/__tests__/behavioral-gate.test.ts` — loaded_pin_sees_voltage_sag
  - [ ] `src/solver/analog/__tests__/behavioral-gate.test.ts` — ideal_pin_sees_full_source_voltage

## 30. [escalate] Pure 1-ULP arithmetic-order divergence not a model bug. Step counts (1004) convergence and iter-0 Jacobian are

- **Root cause:** `src/components/passives/transmission-line-element.ts:268`
- **Expected to fix:** 2 test(s) · confidence medium
- **Fix hint:** This is a zero-tolerance Object.is comparison failing on a 1-ULP delta where ours is more accurate than ngspice. To reach bit-exact match the step-0 DC-OP RHS accumulation order for the TRA MODEDC bridge plus the load resistor must be reord
- **Tests:**
  - [ ] `src/components/passives/__tests__/transmission-line.test.ts` — transient_step_end_paired_matched_load
  - [ ] `src/components/passives/__tests__/transmission-line.test.ts` — full_iteration_paired_matched_load

## 31. [escalate] After an accepted DC-steady-state step the test requires state0[C1.Q]===state1[C1.Q] strictly (Object.is). The

- **Root cause:** `src/components/passives/capacitor.ts:592`
- **Expected to fix:** 2 test(s) · confidence high
- **Fix hint:** The invariant cannot be met through the C*vcap path while node voltages carry 1-ULP solver roundoff between identical steps. Either the recompute must reuse the rotated charge when the converged voltage is unchanged (predictor/INITPRED-styl
- **Tests:**
  - [ ] `src/solver/analog/__tests__/state-pool.test.ts` — pool_state0_state1_agree_slot_for_slot_after_accepted_step
  - [ ] `src/solver/analog/__tests__/state-pool.test.ts` — invariant_persists_across_multiple_accepted_steps

## 32. [engine-fix] ADC driver treats 0.5V indeterminate clk_result as logic-high; must threshold above 0.5 midpoint

- **Root cause:** `src/components/active/adc-driver.ts:290, src/components/active/adc-driver.ts:235`
- **Expected to fix:** 2 test(s) · confidence high
- **Diagnosis:** After hotloading vIH=4.0 the CLK thresholder outputs the 0.5V indeterminate level for a 3.3V clock (0.8<3.3<4.0). The instant-mode EOC-clear branch tests vClock < 0.5 which is false at exactly 0.5, so EOC never clears and stays true. The dr
- **Fix hint:** clk_result carries logic levels 0.0/0.5/1.0 from DigitalInputThresholder. The driver must classify clk high only when vClock > 0.5 (above indeterminate midpoint) for edge detection at line 235-237 and clear EOC when vClock <= 0.5 at line 29
- **Tests:**
  - [ ] `src/components/active/__tests__/adc.test.ts` — hotload_vIH_changes_clock_sensitivity
  - [ ] `src/components/active/__tests__/adc.test.ts` — clock_below_vIH_does_not_trigger_conversion

## 33. [escalate] At default 300.15K this fixture is bit-exact (harness 110/110 converged, firstDivergence null). The harness in

- **Root cause:** `src/components/semiconductors/mosfet.ts:420`
- **Expected to fix:** 2 test(s) · confidence medium
- **Fix hint:** Drill the temp pass tTransconductance (KP/ratio4) tVto and tPhi lines 420 423-430 against mos1temp.c at instanceTemp=350K; the absDelta 3.98 on a source-clamped gate node indicates the temp-shifted operating point sends digiTS NR off vs ngs
- **Tests:**
  - [ ] `src/solver/analog/__tests__/harness/comparison-session-asserts.ts` — temp_350K_compareAllAttempts
  - [ ] `src/solver/analog/__tests__/harness/comparison-session-asserts.ts` — temp_400K_compareAllAttempts

## 34. [engine-fix] RelayDT energised (relay.test.ts:556 fixture relay-dt-canon-energised.dts). harness_matrix_diff classification

- **Root cause:** `src/solver/analog/ni-integrate.ts:64`
- **Expected to fix:** 2 test(s) · confidence medium
- **Fix hint:** Drill the first-transient-step ag fed to the inductor load: at MODEINITTRAN the engine ag[0] driving geq (ni-integrate.ts:64) is half of ngspice. Compare our nicomcof/ag0 seeding for the boot step against ngspice nicomcof.c and the inductor
- **Tests:**
  - [ ] `src/solver/analog/__tests__/harness/comparison-session-asserts.ts` — transient_step_end_paired_dt_energised
  - [ ] `src/solver/analog/__tests__/harness/comparison-session-asserts.ts` — full_iteration_paired_dt_energised

## 35. [engine-fix] enumWaveformCoeffs default arm returns null for waveform noise instead of building a TRNOISE coefficient vecto

- **Root cause:** `src/components/sources/ac-voltage-source.ts:427`
- **Expected to fix:** 2 test(s) · confidence high
- **Fix hint:** Add a case noise arm to enumWaveformCoeffs returning functionType TRNOISE with the seeded coeffs so the noise enum routes onto evaluateNgspiceWaveform; then update the test to assert the deterministic TRNOISE output rather than non-determin
- **Tests:**
  - [ ] `src/components/sources/__tests__/ac-voltage-extended.test.ts` — noise_mode_produces_finite_node_voltage_distinct_from_sine
  - [ ] `src/components/sources/__tests__/ac-voltage-source.test.ts` — hotload_noiseSampleTime_changes_noise_breakpoint_schedule

## 36. [test-design] Test calls computeWaveformValue noise directly expecting a Box-Muller gaussian return, but the noise arm of co

- **Root cause:** `src/components/sources/ac-voltage-source.ts:513`
- **Expected to fix:** 2 test(s) · confidence high
- **Fix hint:** Retarget the statistical audit at the seeded TRNOISE generator via evaluateNgspiceWaveform with a TRNOISE coefficient vector (randnumb recon) instead of computeWaveformValue noise, or delete this test as it asserts the removed non-determini
- **Tests:**
  - [ ] `src/components/sources/__tests__/noise.test.ts` — gaussian_distribution_mean_near_zero_stddev_near_amplitude
  - [ ] `src/components/sources/__tests__/noise.test.ts` — lag1_autocorrelation_below_threshold

## 37. [engine-fix] ComponentCurrentPath carries no element identity (eIdx or label) and resolve() builds _componentPaths skipping

- **Root cause:** `src/editor/wire-current-resolver.ts:32`
- **Expected to fix:** 2 test(s) · confidence high
- **Fix hint:** Add an element identity field (elementIndex or label) to ComponentCurrentPath and populate it at the push sites in resolve() (lines 298 and 304) so consumers map a body path to its element by identity instead of positional index.
- **Tests:**
  - [ ] `src/editor/__tests__/wire-current-resolver.test.ts` — parallel split at junction: branch wires carry their branch current
  - [ ] `src/editor/__tests__/wire-current-resolver.test.ts` — every junction wires carry positive current and KCL is satisfied

## 38. [engine-fix] The warm-start transient DC operating point (_transientDcop -> solveDcOperatingPoint -> _seedFromDcop) is defe

- **Root cause:** `src/solver/analog/analog-engine.ts:317`
- **Expected to fix:** 2 test(s) · confidence high
- **Fix hint:** Run the initial transient operating-point solve at init()/compile() time (capturing the source value present then) so a later hot setSignal followed by step() continues the transient from the established reactive-element state rather than r
- **Tests:**
  - [ ] `src/headless/__tests__/rlc-lte-path.test.ts` — RC step response: exponential charging matches V(1-e^-t/tau)
  - [ ] `src/headless/__tests__/rlc-lte-path.test.ts` — RL step response: V_R matches 1-e^-t/tau (R=10 L=1mH tau=100us)

## 39. [engine-fix] TransGate compiles in the digital domain so its boundary source pins (vs/vp1/vp2/load) each get a BridgeOutput

- **Root cause:** `src/solver/analog/behavioral-drivers/bridge-output-driver.ts:154`
- **Expected to fix:** 2 test(s) · confidence high
- **Fix hint:** The bridge boundary drivers inject a parasitic 1/rHiZ (and 1/rOut) conductance that the ngspice deck has no counterpart for. Either suppress the bridge diagonal conductance stamp when the boundary pin is an ideal source (so the matrix match
- **Tests:**
  - [ ] `src/solver/analog/__tests__/harness/comparison-session.ts` — transient_step_end_paired_pass_through
  - [ ] `src/solver/analog/__tests__/harness/comparison-session.ts` — transient_step_end_paired_isolation

## 40. [engine-fix] AnalogClockElementImpl.setParam is an empty no-op so setComponentProperty(vdd, 5) is dropped and V(out) stays 

- **Root cause:** `src/components/io/clock.ts:306`
- **Expected to fix:** 2 test(s) · confidence high
- **Fix hint:** Make _vdd (and _halfPeriod) mutable and implement setParam: key vdd updates _vdd, key Frequency recomputes _halfPeriod = 1/(2*value). The instantaneousValue/breakpoint math already reads these fields so the change becomes observable immedia
- **Tests:**
  - [ ] `src/components/io/__tests__/analog-clock.test.ts` — hotload_vdd_changes_out_voltage
  - [ ] `src/components/io/__tests__/analog-clock.test.ts` — hotload_Frequency_changes_breakpoint_schedule

## 41. [engine-fix] relError 1.4 percent between iOhm=(Vs-Vd)/R and iShockley=Is*(exp(Vd/(n*Vt))-1) at the converged Vd=0.633685V.

- **Root cause:** `src/solver/analog/__tests__/mna-end-to-end.test.ts:435`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** Set the test Vt to CONSTKoverQ*300.15 (=0.0258646V) rather than 0.02585, matching the engine REFTEMP of 300.15K (27C). No source change; the diode load uses the correct ngspice thermal voltage.
- **Tests:**
  - [ ] `src/solver/analog/__tests__/mna-end-to-end.test.ts` — diode_shockley_equation_consistency

## 42. [engine-fix] lastStep.branches[l1:branch].ours reads 5.0 (the vs:pos node voltage) instead of the 0.05A inductor branch cur

- **Root cause:** `src/solver/analog/__tests__/harness/comparison-session.ts:1480`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** Index the 1-based voltages array with row+1 in the branch loop (ourFinal.voltages[row+1] and ngFinal.voltages[row+1]) at comparison-session.ts:1480-1481, or store branch rows 1-based in capture.ts:260. Same off-by-one exists at the sibling 
- **Tests:**
  - [ ] `src/solver/analog/__tests__/mna-end-to-end.test.ts` — rl_dc_steady_state_tight_tolerance

## 43. [engine-fix] digiTS ignores .nodeset on the production compile path so its NR settles at the symmetric metastable point (Q1

- **Root cause:** `src/solver/analog/compiler.ts:1571`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** In the analog compiler, resolve parsed .nodeset net/pin names to MNA node ids and pass a nodesets Map into the ConcreteCompiledAnalogCircuit constructor at compiler.ts:1571 (parallel to how ics should flow). Downstream apply/seed machinery 
- **Tests:**
  - [ ] `src/solver/analog/__tests__/nr-nodeset-parity.test.ts` — nodeset_steers_ngspice_to_latch_state_digiTS_does_not

## 44. [engine-fix] Test expects 2 NR iterations for a linear resistor divider but the engine returns 3. The DC-OP runs ngspice CK

- **Root cause:** `src/solver/analog/__tests__/newton-raphson.test.ts:130`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** Change the expectation at newton-raphson.test.ts:130 to toBe(3) to match the INITJCT/INITFIX/INITFLOAT ladder both engines run. No source change; newton-raphson.ts iteration count matches ngspice STATnumIter.
- **Tests:**
  - [ ] `src/solver/analog/__tests__/newton-raphson.test.ts` — linear_converges_in_two_iterations

## 45. [engine-fix] The test expects clamping gmMax to change the converged V_out, but gmMax is a Jacobian-only quantity. In load(

- **Root cause:** `src/components/active/ota.ts:226`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** This is a test-contract error not a source bug: gmMax only bounds the linearization slope and cancels at the fixed point. Either assert on convergence iteration behavior or remove the not.toBeCloseTo expectation; do not alter ota.ts load() 
- **Tests:**
  - [ ] `src/components/active/__tests__/ota.test.ts` — hotload_gmMax_clamp_changes_vout_in_linear_region

## 46. [engine-fix] createAnalogFuseElement (and buildAnalogFuseElement constructor) never reads the blown property to seed _intac

- **Root cause:** `src/components/passives/analog-fuse.ts:323`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** Seed _intact from props.blown: add a blown param to AnalogFuseElement constructor (initializing _intact = !blown) and pass props.getOrDefault blown false through buildAnalogFuseElement and createAnalogFuseElement so a fuse built blown uses 
- **Tests:**
  - [ ] `src/components/switching/__tests__/fuse.test.ts` — hotload_rBlown_changes_blown_output_voltage

## 47. [engine-fix] The DC-OP node voltage at rLoadC:pos is 0.9998 (ours) vs 0.9999 (ngspice); harness_first_divergence localizes 

- **Root cause:** `src/components/switching/current-controlled-switch.ts:311`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** This is an architectural divergence to escalate, not a numerical bug: the normallyClosed inversion in current-controlled-switch.ts:311 has no ngspice CSW counterpart and the ON keyword at netlist-generator.ts:905 is not equivalent to it. To
- **Tests:**
  - [ ] `src/components/switching/__tests__/relay.test.ts` — dcop_paired_dt_energised

## 48. [engine-fix] The fixture wires two non-tri-state digital drivers onto rf:Rw (the Splitter output spl:0,1 and the In in_rw:o

- **Root cause:** `src/solver/digital/bus-resolution.ts:75`
- **Expected to fix:** 1 test(s) · confidence medium
- **Fix hint:** Mask each driver value and non-highZ mask to the net declared bit width before the conflict XOR at bus-resolution.ts:75 (carry the net width into resolveBusDrivers and AND driverValue/driverNonHighZ with the width mask), so phantom upper-bi
- **Tests:**
  - [ ] `src/components/memory/__tests__/register.test.ts` — masked_addresses_are_independent_across_distinct_register_slots

## 49. [engine-fix] diac-canon-breakover step-0 DCOP fails to converge (ours 2400 NR iters failed; ngspice 5 converged) so compare

- **Root cause:** `src/components/semiconductors/diode.ts:942`
- **Expected to fix:** 1 test(s) · confidence medium
- **Fix hint:** Same as full_iteration_paired_blocking: use harness_get_attempt on DIAC1_D_rev across the failing DCOP iters to confirm the breakdown pnjlim operands (diode.ts:942-948 vs dioload.c:219-243). The +66V VD shows vd crossing from reverse-breakd
- **Tests:**
  - [ ] `src/solver/analog/__tests__/harness/comparison-session-asserts.ts` — full_iteration_paired_breakover

## 50. [engine-fix] Unresolved (no line localized)

- **Root cause:** `UNRESOLVED`
- **Expected to fix:** 1 test(s) · confidence low
- **Diagnosis:** Test loops while simTime<1e-3 (one RC time constant for R=1k C=1uF) then asserts a node exceeds 4.4V; at t=1ms an ideal RC cap reaches only 5*(1-e^-1)=3.16V, below 4.4V, so the threshold is reachable only if the final accepted step overshoo
- **Fix hint:** Run harness on an equivalent RC .dts (R=1k C=1uF stopTime=5e-3) and compare cap-node voltage trajectory vs ngspice via harness_get_attempt to decide engine-bug vs test-threshold; the 4.4V threshold at 1ms is physically inconsistent with the
- **Tests:**
  - [ ] `src/solver/analog/__tests__/convergence-regression.test.ts` — RC circuit runs transient steps stably with capacitor near Vs

## 51. [engine-fix] Test runs analysis dcop only (no transient step) then reads d1 state1 VD, expecting >0.5. state0->state1 copy 

- **Root cause:** `src/solver/analog/analog-engine.ts:2282`
- **Expected to fix:** 1 test(s) · confidence medium
- **Fix hint:** Either the test must take one accepted transient step before reading state1 (its name says after accepted transient step but it builds with analysis dcop and never steps), or dcop convergence must seed state1 from state0. Decide contract; i
- **Tests:**
  - [ ] `src/solver/analog/__tests__/convergence-regression.test.ts` — statePool state1 is updated after accepted transient step

## 52. [engine-fix] Harness evidence: at step0 tranNR iter0 BOTH sides record an identical AK pnjlim event (vBefore=vAfter=0.49927

- **Root cause:** `src/solver/analog/__tests__/harness/comparison-session.ts:3066`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** In getLimitingComparison normalize the SPICE type prefix when matching ng events to the requested label (strip leading device-type letter D/Q/M/J for diode/bjt/mos/jfet) or match on the bridge deviceName mapped back to our label, the same w
- **Tests:**
  - [ ] `src/components/semiconductors/__tests__/varactor.test.ts` — limiting_paired_forward

## 53. [engine-fix] getPinCurrents (ntc-thermistor.ts:292-304) unconditionally reads tOld from the TEMPERATURE pool slot states[1]

- **Root cause:** `src/components/sensors/ntc-thermistor.ts:298`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** In getPinCurrents branch on _selfHeating like load() does: when !_selfHeating use this._tAmbient for tOld (and computeRFromT) so a hot-loaded temperature is reflected; only read the TEMPERATURE slot in self-heating mode.
- **Tests:**
  - [ ] `src/components/sensors/__tests__/ntc-thermistor-rollback.test.ts` — hotload_temperature_changes_resistance_in_fixed_mode

## 54. [engine-fix] The AM evaluation at ac-voltage-source.ts:498 (dcOffset + (1+depth*sin(2pi*modFreq*t))*amplitude*sin(arg)) is 

- **Root cause:** `src/components/sources/ac-voltage-source.ts:498`
- **Expected to fix:** 1 test(s) · confidence medium
- **Fix hint:** This is a test-expectation issue: either step the fixture to a non-trivial t (e.g. a few modulation periods, t ~ 1/modFreq) before reading, or relax the AM divergence assertion to the achievable magnitude (~1e-7) / assert relative differenc
- **Tests:**
  - [ ] `src/components/sources/__tests__/ac-voltage-extended.test.ts` — am_mode_diverges_from_pure_sine_after_warmstart

## 55. [engine-fix] Cached VPK slot (247.22459) differs from the final converged node difference vP-vK (247.22386) by 0.73 mV vs t

- **Root cause:** `src/components/semiconductors/triode-analog-element.ts:311`
- **Expected to fix:** 1 test(s) · confidence medium
- **Fix hint:** This is correct SPICE-parity caching - the slot is meant to lag by one iteration. The test expectation at line 98 (cached VPK == final node difference to 5e-10) is wrong; loosen it to the NR convergence tolerance or compare against the pre-
- **Tests:**
  - [ ] `src/components/semiconductors/__tests__/triode.test.ts` — init_seeded_op_point_slots

## 56. [engine-fix] After raising vIH/vIL so sel=2.5V reclassifies LOW, a single transient step() does not fully propagate the new

- **Root cause:** `src/solver/analog/behavioral-drivers/mux-driver.ts:95`
- **Expected to fix:** 1 test(s) · confidence medium
- **Fix hint:** Re-settle to DCOP after the threshold hotload before reading, or restructure the thresholder/driver chain so a within-step NR fully propagates (chain of rhsOld-fed Norton sources lags one layer per iteration).
- **Tests:**
  - [ ] `src/solver/analog/__tests__/behavioral-combinational.test.ts` — hotload_vIH_shifts_digital_input_threshold

## 57. [engine-fix] Behavioral D-FF preset yields ~Q=1 when Q=1 (expected ~Q=0). The edge detector uses a continuous product risin

- **Root cause:** `src/solver/analog/behavioral-drivers/d-flipflop-driver.ts:85`
- **Expected to fix:** 1 test(s) · confidence medium
- **Fix hint:** Replace the multiplicative edge detector and instance-field _firstSample with the documented NaN-sentinel scheme in SLOT_LAST_CLOCK: detect a true 0->1 edge against the prior accepted-step clock and skip detection only when LAST_CLOCK is Na
- **Tests:**
  - [ ] `src/solver/analog/__tests__/behavioral-flipflop.test.ts` — behavioral_preset_preserves_digital_truth_q_qbar_after_rising_edge_d1

## 58. [engine-fix] The test reads node D1:A which is wired directly to the ideal voltage source v1:pos (buildSchottkyForward conn

- **Root cause:** `src/components/semiconductors/__tests__/schottky.test.ts:138`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** Test-design bug: assert on the diode internal voltage drop (V(D1:A)-V(D1:K)) or the cathode node, not the source-clamped anode node. Diode source RS path is correct.
- **Tests:**
  - [ ] `src/components/semiconductors/__tests__/schottky.test.ts` — hotload_RS_changes_anode_voltage

## 59. [engine-fix] The test reads node D1:A which equals the ideal source node v1:pos (clamped to 0.5V), so before and after are 

- **Root cause:** `src/components/semiconductors/__tests__/schottky.test.ts:156`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** Test-design bug: read a non-source-clamped node (cathode D1:K or the internal prime) to observe the CJO-dependent transient. The diode cap path (diode.ts computeJunctionCapacitance/Charge) is correct.
- **Tests:**
  - [ ] `src/components/semiconductors/__tests__/schottky.test.ts` — hotload_CJO_changes_dynamic_response

## 60. [engine-fix] vfAfter (0.1081312) differs from vfOverride (0.1081302) by 1.0076e-6, just over the 5e-7 (6-digit) tolerance. 

- **Root cause:** `src/components/semiconductors/diode.ts:1388`
- **Expected to fix:** 1 test(s) · confidence medium
- **Fix hint:** Borderline NR-tolerance gap, not a temperature-override bug. Either re-run a full DCOP before reading vfAfter, or the single step settles within reltol*Vf+vAbsTol (1e-6 here) - which exceeds the 6-digit assertion. Override-hold logic is cor
- **Tests:**
  - [ ] `src/components/semiconductors/__tests__/schottky.test.ts` — computeTemperature_per_instance_override_wins_over_ambient

## 61. [engine-fix] vEN reads 0 because the Counter compiles as its digital model. Counter.defaultModel is digital (counter.ts:432

- **Root cause:** `src/components/memory/counter.ts:279`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** Two parts: (1) the analog loading override path requires the behavioral netlist; either the test must set model:behavioral or the override compile path must force the analog model when digitalPinLoadingOverrides target a component. (2) buil
- **Tests:**
  - [ ] `src/solver/analog/__tests__/behavioral-sequential.test.ts` — loaded_en_sees_voltage_sag_ideal_clk_clr_see_no_sag

## 62. [engine-fix] CCVSAnalogElement.setParam only handles senseSourceLabel and silently ignores transresistance. The transresist

- **Root cause:** `src/components/active/ccvs.ts:180`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** Add a transresistance branch to setParam (line 180-184) that, when the expression is the default I(sense) linear shortcut, reparses value * I(sense) and updates the elements compiled expression and derivative (the _compiledExpr/_compiledDer
- **Tests:**
  - [ ] `src/components/active/__tests__/ccvs.test.ts` — hotload_transresistance_changes_vout

## 63. [engine-fix] weightBefore and weightAfter are both 1. The buildFixture warm-start runs a DC-family solve and the DC branch 

- **Root cause:** `src/components/active/comparator-driver.ts:181`
- **Expected to fix:** 1 test(s) · confidence medium
- **Fix hint:** The DC weight collapse pre-saturates OUTPUT_WEIGHT so the transient integration test starts at the target. Either the DC branch should not persist the steady-state weight into the slot used by the subsequent transient integration (write the
- **Tests:**
  - [ ] `src/components/active/__tests__/comparator.test.ts` — hotload_responseTime_changes_weight_integration

## 64. [engine-fix] AC triangle-RC (ac-voltage-source.test.ts:567 fixture acvsource-canon-triangle-rc.dts). Steps 0-28 match bit-e

- **Root cause:** `src/solver/analog/timestep.ts:435`
- **Expected to fix:** 1 test(s) · confidence medium
- **Fix hint:** Replay from the first non-matching delta: compare our computeNewDt (timestep.ts:412-456, 2x growth cap line 440) and getClampedDt post-breakpoint saveDelta clamp (line 529) against ngspice CKTtrunc/dctran.c around the 0.5ms valley to 1.5ms 
- **Tests:**
  - [ ] `src/solver/analog/__tests__/harness/comparison-session-asserts.ts` — full_iteration_paired_triangle_rc

## 65. [engine-fix] Step 8d compile-time state seeding only handles el.typeId===Function; there is no branch that seeds the FGPFET

- **Root cause:** `src/solver/digital/compiler.ts:647`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** Add an FGPFET (and FGNFET) branch in the Step 8d seeding loop (compiler.ts:645-665) that writes initialStateSlots[stBase+1] = blown property ? 1 : 0, mirroring the Function truth-table seeding.
- **Tests:**
  - [ ] `src/components/switching/__tests__/fets.test.ts` — blown_property_seeds_state_to_permanently_off

## 66. [test-fixture] Fixture builds the ProgramCounter at bitWidth:1 (test line 77) so mask=1; incrementing the loaded value 1 give

- **Root cause:** `src/components/memory/program-counter.ts:240`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** Fixture/test bug: build the PC at bitWidth>=2 so Q=2 is representable. Source line 240 is correct ngspice-style modular increment.
- **Tests:**
  - [ ] `src/components/memory/__tests__/program-counter.test.ts` — jump_then_increment_continues_from_loaded_value

## 67. [engine-fix] setParam(IC) only stores this._IC=value. The IC flux seed s0[PHI]=L/m*IC fires solely in loadFluxInit under MO

- **Root cause:** `src/components/passives/inductor.ts:685`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** In setParam(IC), when stateBase/pool are live, seed s0[PHI]=s1[PHI]=(_effectiveL/_M)*value (mirror the memristor initialState setParam that writes both s0 and s1).
- **Tests:**
  - [ ] `src/components/passives/__tests__/inductor.test.ts` — hotload_IC_seeds_uic_initial_branch_current

## 68. [engine-fix] After buildFixture warm-start (one transient step) the last-accepted W lives in s1 because rotateStateVectors 

- **Root cause:** `src/components/passives/memristor.ts:226`
- **Expected to fix:** 1 test(s) · confidence medium
- **Fix hint:** In DC mode the memristor must read the last-accepted W from s1 (like the inductor), not s0. Reading s0 only holds the seed on the FIRST load before any rotation; after a warm-start rotation the valid value is in s1. Resolve W from s1 (or se
- **Tests:**
  - [ ] `src/components/passives/__tests__/memristor-rollback.test.ts` — dcop_resistive_divider_at_initial_state

## 69. [engine-fix] On LTE rejection the engine (analog-engine.ts:625-636) only rewinds simTime and sets dt=newDt; it deliberately

- **Root cause:** `src/solver/analog/analog-engine.ts:625`
- **Expected to fix:** 1 test(s) · confidence medium
- **Fix hint:** Either the rejection path must restore state pool s0 from s1 before the retry to honor the asserted invariant, or the test invariant is wrong (ngspice intentionally does not restore state on LTE reject). Escalate: this is a state-rotation-o
- **Tests:**
  - [ ] `src/components/passives/__tests__/crystal.test.ts` — lte_rollback_state_invariant_after_rejection

## 70. [engine-fix] The test asserts an LTE rejection MUST occur for the square-wave RL (L=1e-3,R=1,500Hz,5ms,free-running maxStep

- **Root cause:** `src/solver/analog/timestep.ts:616`
- **Expected to fix:** 1 test(s) · confidence medium
- **Fix hint:** Test-precondition gap, not a source bug: shouldReject and cktTerr match ngspice. To exercise the rollback path the fixture needs sharper flux gradients or smaller minTimeStep so worstRatio exceeds 1.111, or the test must not assume a reject
- **Tests:**
  - [ ] `src/components/passives/__tests__/inductor.test.ts` — lte_rollback_state_invariant

## 71. [engine-fix] Harness on transformer-canon-ac-step-down.dts shows our engine runs only 1 step then stalls (lastDt=0, did not

- **Root cause:** `src/solver/analog/analog-engine.ts:1082`
- **Expected to fix:** 1 test(s) · confidence medium
- **Fix hint:** Make the transient first-step seeding (currentDt=firstStep and _seedFromDcop) robust to the transformer coupled-inductor DCOP path so MODEINITTRAN and a nonzero first dt are established; root the upstream DCOP convergence for the singular c
- **Tests:**
  - [ ] `src/components/passives/__tests__/transformer.test.ts` — dcop_paired_ac_step_down

## 72. [engine-fix] BV hot-load does not propagate into the diode breakdown behavior. MCP evidence: building the same reverse-bias

- **Root cause:** `src/components/semiconductors/diode.ts:1379`
- **Expected to fix:** 1 test(s) · confidence medium
- **Fix hint:** Make the diode setParam(BV,...) path re-establish the breakdown regime: ensure the finite-BV branch flags/seed used at setup (and the warm-start junction voltage) are refreshed so the next solve re-enters the breakdown arm, matching the com
- **Tests:**
  - [ ] `src/components/semiconductors/__tests__/diode.test.ts` — hotload_BV_changes_reverse_breakdown_vd

## 73. [engine-fix] Capacitor.setParam(capacitance) updates only _nominalC; the stamped capacitance this.C is recomputed solely in

- **Root cause:** `src/components/passives/capacitor.ts:491`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** In capacitor.ts setParam, after setting _nominalC recompute this.C = _nominalC * _SCALE (or have the engine re-run computeTemperature on any param change) so capacitance is truly hot-loadable.
- **Tests:**
  - [ ] `src/components/passives/__tests__/polarized-cap.test.ts` — hotload_capacitance_changes_first_step_current

## 74. [engine-fix] Test reads getElementPinCurrents on cap:cBody (the capacitor body) expecting it to track V/esr. esr does hot-l

- **Root cause:** `src/components/passives/polarized-cap.ts:641`
- **Expected to fix:** 1 test(s) · confidence medium
- **Fix hint:** Read the ESR-limited current off cap:rEsr (the resistor in the series path), not the cap:cBody companion current, and read it at the first transient step before charging dominates.
- **Tests:**
  - [ ] `src/components/passives/__tests__/polarized-cap.test.ts` — hotload_esr_changes_initial_step_current

## 75. [engine-fix] harness_first_divergence earliest = matrix cell (nCap,nCap) at step0/iter0, classification value-only, single 

- **Root cause:** `src/solver/analog/ngspice-load-order.ts:0`
- **Expected to fix:** 1 test(s) · confidence medium
- **Fix hint:** Align the per-leaf load() walk order for the PolarizedCap composite so rEsr/rLeak/cBody stamp the nCap diagonal in the same sequence ngspice loads them (RESload before CAPload); verify expandCompositeInstance/ngspiceLoadOrder leaf ordering 
- **Tests:**
  - [ ] `src/components/passives/__tests__/polarized-cap.test.ts` — dcop_paired_reverse_bias

## 76. [engine-fix] events.length>=1 passes (line 573); the failing assertion is line 574 .some(e.junction===VD || e.junction.star

- **Root cause:** `src/components/semiconductors/diode.ts:1258`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** Make _recordLimit emit the junction name VD (matching the DIOvoltage state-slot name at diode.ts:68 and ngspice diodefs.h:196) instead of the literal AK, so limiting events are identified by the same junction label the rest of the diode mod
- **Tests:**
  - [ ] `src/components/passives/__tests__/polarized-cap.test.ts` — limiting_pnjlim_fires_on_clamp_diode_under_reverse_bias

## 77. [engine-fix] Test enables the convergence log via coordinator.setConvergenceLogEnabled(true) (coordinator.ts:482-491) AFTER

- **Root cause:** `src/solver/analog/analog-engine.ts:681`
- **Expected to fix:** 1 test(s) · confidence low
- **Fix hint:** Confirm via convergence log whether the engine errors on this fixture; if it errors, ensure the error-exit path records a StepRecord so the log is non-empty, or relax the fixture stiffness. If it does not error, audit why accepted steps ski
- **Tests:**
  - [ ] `src/components/passives/__tests__/polarized-cap.test.ts` — lte_rollback_q_slot_rotation_invariant

## 78. [engine-fix] harness_run on the tapped-transformer ac-sinusoid fixture: our engine produces only 1 step then errors Our eng

- **Root cause:** `src/solver/analog/analog-engine.ts:1091`
- **Expected to fix:** 1 test(s) · confidence medium
- **Fix hint:** Trace why _params.firstStep (resolveSimulationParams) is 0 for these transformer transient runs so the first-step dt feeds a nonzero ag0; the inductor/mutual stamp code is ngspice-faithful and is not the bug. Engine first-transient-step dt 
- **Tests:**
  - [ ] `src/components/passives/__tests__/tapped-transformer.test.ts` — dcop_paired_ac_sinusoid

## 79. [engine-fix] setComponentProperty routes a parent hot-load to only ONE flattened analog sub-element. _resolveElementIndex (

- **Root cause:** `src/solver/coordinator.ts:915`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** Make setComponentProperty fan out the param to ALL analog sub-elements whose CircuitElement is the target (iterate elementToCircuitElement collecting every idx for the element, call setParam on each), so composite-nested consumers like the 
- **Tests:**
  - [ ] `src/components/active/__tests__/dac.test.ts` — hotload_vIH_shifts_threshold_so_3p3v_reads_low

## 80. [engine-fix] DACDriver stamps an ideal VSRC branch (V_OUT - V_GND = target exactly, lines 196-200) with no series output re

- **Root cause:** `src/components/active/dac-driver.ts:196`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** Stamp a Thevenin output (target voltage behind rOut) in DACDriver.load instead of an ideal VSRC branch, and wire the rOut param into the driver so output impedance creates the divider; make rOut hot-loadable via setParam.
- **Tests:**
  - [ ] `src/components/active/__tests__/dac.test.ts` — hotload_rOut_sags_output_under_load

## 81. [engine-fix] OpampElement.setParam writes only this._p[key], but load() computes the RES conductance G = 1/this._rOut using

- **Root cause:** `src/components/active/opamp.ts:298`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** In setParam, when key===rOut update this._rOut (or make load/G read this._p.rOut directly so the live value drives the conductance). The cached _rOut field and _p must not diverge.
- **Tests:**
  - [ ] `src/components/active/__tests__/opamp.test.ts` — hotload_rOut_changes_output_divider

## 82. [engine-fix] Verified via circuit_dc_op: t:DIS stays pinned at ~5V (VCC) regardless of disBase. disBase correctly tracks vD

- **Root cause:** `src/components/active/timer-555.ts:56`
- **Expected to fix:** 1 test(s) · confidence medium
- **Fix hint:** The discharge BJT must saturate and pull DIS toward GND when the base is driven to vDrop. Investigate the bjtDis NpnBJT spice-model area/IS defaults and the disBase clamp interaction (latch-driver.ts:123-126 G_base=1 Norton) so collector cu
- **Tests:**
  - [ ] `src/components/active/__tests__/timer-555-debug.test.ts` — hotload_vDrop_changes_dis_base_voltage

## 83. [engine-fix] VCCSAnalogElement.setParam is an empty no-op (params underscored, no body), so setComponentProperty(transcondu

- **Root cause:** `src/components/active/vccs.ts:162`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** Implement setParam so key transconductance (and gain/m) rebuilds the linear expression / effectiveGm = transconductance*m used in stampOutput, mirroring how other controlled sources hot-reload; update the cached expression+derivative used b
- **Tests:**
  - [ ] `src/components/active/__tests__/vccs.test.ts` — hotload_transconductance_changes_output_voltage

## 84. [engine-fix] setParam(cIn) updates only this._spec.cIn but never the child AnalogCapacitorElement which holds its own capac

- **Root cause:** `src/solver/analog/behavioral-drivers/bridge-input-driver.ts:124`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** In setParam case cIn forward the value to the child cap: this._capChild?.setParam(capacitance, value) (and reconcile when _capChild is null but value becomes >0). The spec field alone is not what gets stamped.
- **Tests:**
  - [ ] `src/components/digital-pins/__tests__/dipl-hot-load.test.ts` — Loaded: setComponentProperty(dipl, cIn, 1e-7) slows RC settling — binding is observable in transient

## 85. [engine-fix] prevClock state slot initializes to 0. When C is set high before any step, the first sampleMonoflop sees clock

- **Root cause:** `src/components/flipflops/monoflop.ts:163`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** Seed prevClock from the actual initial clock level so a pre-existing high does not register as a rising edge (e.g. initialize prevClock=clock on the first sample, or have the engine prime prevClock from initial inputs before the first execu
- **Tests:**
  - [ ] `src/components/flipflops/__tests__/monoflop.test.ts` — clock_stays_high_no_trigger

## 86. [engine-fix] executeGraphicCard packs the D output (addr<<0 | str<<16 | clk<<17 | ld<<18 | bank<<19 = 983045 = 0xF0005) int

- **Root cause:** `src/components/graphics/graphic-card.ts:348`
- **Expected to fix:** 1 test(s) · confidence high
- **Fix hint:** Mask the packed output to the data bus width: read dataBits via layout.getProperty(index, dataBits) and AND the result with ((1<<dataBits)-1) (handle dataBits>=32 as full width) before writing state[wt[outputIdx]].
- **Tests:**
  - [ ] `src/components/graphics/__tests__/graphic-card.test.ts` — dataBits_8_truncates_packed_d_low_byte_dataBits_24_preserves_full

