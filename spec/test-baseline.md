# Test Baseline

- **Timestamp**: 2026-04-28T11:32:52.303Z
- **Phase**: setup-load-cleanup mega-wave
- **Command**: npm run test:q
- **Result**: 8154/8907 passing, 738 failing, 15 skipped (26.6s, 400 files)

## Summary

Total test failures organized by error type: 88 distinct failure categories affecting 738 test cases.

## Failing Tests (pre-existing)

| Test | Status | Summary |
|------|--------|---------|
| src\editor\__tests__\wire-current-resolver.test.ts::DC parallel split: junction wires carry correct individual currents | FAIL | makeVoltageSource is not a function (194 occurrences) |
| src\editor\__tests__\wire-current-resolver.test.ts::RLC junction: wire currents match element currents at every AC timestep | FAIL | makeAcVoltageSource is not a function (7 occurrences) |
| src\editor\__tests__\wire-current-resolver.test.ts::cross-component current equality through real compiled lrctest.dig | FAIL | expected 0 to be greater than 0.045000000000000005 |
| src\editor\__tests__\wire-current-resolver.test.ts::component-as-node KCL: wire at pin A ≈ wire at pin B ≈ body current | FAIL | expected 0 to be greater than 0 (4 occurrences) |
| src\solver\analog\analog-engine.ts::DC operating point has all-finite node voltages (ground synthesis produces solvable matrix) | FAIL | el.setup is not a function (14 occurrences) |
| src\compile\__tests__\coordinator.test.ts::step does not throw for analog-only circuit | FAIL | expected [Function] to not throw an error but 'TypeError: el.setup is not a function' was thrown (3 occurrences) |
| src\headless\__tests__\rlc-lte-path.test.ts::RC step response: exponential charging matches V(1-e^-t/τ) | FAIL | expected 4.9999999999999885 to be less than or equal to 3.223814850025644 |
| src\headless\__tests__\rlc-lte-path.test.ts::RL step response: V_R matches 1-e^-t/τ (R=10, L=1mH, τ=100µs) | FAIL | expected NaN to be greater than or equal to 0.6194781476519865 |
| src\headless\__tests__\rlc-lte-path.test.ts::RL resistor zero-crossings at f=200Hz (f<<fc): ≥6 crossings over 4 periods | FAIL | expected 0 to be greater than or equal to 0.9 |
| src\io\__tests__\dts-load-repro.test.ts::step fixtures/buckbjt.dts | FAIL | expected [Function] to not throw an error but 'Error: Analog engine stagnation: simT…' was thrown |
| src\solver\__tests__\coordinator-bridge.test.ts::outputAdapter.setLogicLevel(true) drives vOH on the branch RHS | FAIL | Cannot destructure property 'row' of 'this._handles[handle]' as it is undefined. (16 occurrences) |
| src\solver\__tests__\coordinator-speed-control.test.ts::formatSpeed returns micros/s for rate in 1e-6 to 1e-3 range | FAIL | expected 'µs/s' to be 'Âµs/s' // Object.is equality |
| src\components\active\__tests__\dac.test.ts::full_scale | FAIL | withNodeIds is not a function (119 occurrences) |
| src\components\active\__tests__\opamp.test.ts::linear_region_vcvs_stamps_with_rout | FAIL | solver is not defined (4 occurrences) |
| src\components\sources\dc-voltage-source.ts::linear_region | FAIL | number 1 is not iterable (cannot read property Symbol(Symbol.iterator)) (19 occurrences) |
| src\components\active\__tests__\real-opamp.test.ts::real_opamp_load_dcop_parity | FAIL | expected +0 to be 5e-7 // Object.is equality |
| src\components\active\__tests__\schmitt-trigger.test.ts::noisy_sine_clean_square | FAIL | expected +0 to be 10 // Object.is equality |
| src\components\active\__tests__\schmitt-trigger.test.ts::plot_matches_hysteresis_loop | FAIL | expected null not to be null |
| src\components\active\__tests__\schmitt-trigger.test.ts::schmitt_load_dcop_parity | FAIL | expected +0 to be 1e-7 // Object.is equality |
| src\components\io\clock.ts::analogFactory_creates_element- factory produces a valid AnalogElement | FAIL | props.getOrDefault is not a function (4 occurrences) |
| src\components\io\__tests__\analog-clock.test.ts::stamp_produces_incidence_entries- voltage source topology | FAIL | Cannot read properties of undefined (reading '2') (4 occurrences) |
| src\components\io\__tests__\led.test.ts::junction_cap_transient_matches_ngspice | FAIL | expected +0 to be 0.4862002658788155 // Object.is equality |
| src\components\io\__tests__\led.test.ts::pushes AK pnjlim event on non-init NR iteration | FAIL | expected false to be true // Object.is equality (3 occurrences) |
| src\components\io\__tests__\led.test.ts::vt_reflects_TEMP | FAIL | expected 0.7614530246405854 to be less than 1e-10 (2 occurrences) |
| src\components\passives\capacitor.ts::computes correct geq and ieq for trapezoidal method | FAIL | props.getModelParam is not a function (105 occurrences) |
| src\components\passives\__tests__\crystal.test.ts::CrystalDefinition branchCount is 1 | FAIL | expected undefined to be 1 // Object.is equality (5 occurrences) |
| src\components\passives\__tests__\memristor.test.ts::positive voltage causes w to increase | FAIL | expected NaN to be greater than 0.5 |
| src\components\passives\__tests__\memristor.test.ts::positive voltage causes resistance to decrease | FAIL | expected NaN to be less than 8050 |
| src\components\passives\__tests__\memristor.test.ts::negative voltage causes w to decrease | FAIL | expected NaN to be less than 0.5 |
| src\components\passives\__tests__\memristor.test.ts::negative voltage causes resistance to increase | FAIL | expected NaN to be greater than 8050 |
| src\components\passives\__tests__\memristor.test.ts::I-V characteristic is different for increasing vs decreasing V (pinched loop) | FAIL | expected NaN to be greater than 0.001 |
| src\components\passives\__tests__\memristor.test.ts::large positive current never pushes w above 1.0 | FAIL | expected NaN to be less than or equal to 1 |
| src\components\passives\__tests__\memristor.test.ts::large negative current never pushes w below 0.0 | FAIL | expected NaN to be greater than or equal to 0 |
| src\components\passives\__tests__\memristor.test.ts::stamps conductance between nodes A and B | FAIL | expected +0 to be 0.00503125 // Object.is equality |
| src\components\passives\__tests__\memristor.test.ts::memristor_load_transient_parity | FAIL | expected undefined to be 0.00503125 // Object.is equality |
| src\components\passives\polarized-cap.ts::emits reverse-biased-cap diagnostic when V(pos) < V(neg) - reverseMax | FAIL | Cannot set properties of undefined (setting 'stateBaseOffset') (6 occurrences) |
| src\components\sources\dc-voltage-source.ts::voltage_divider_dc_op | FAIL | number 2 is not iterable (cannot read property Symbol(Symbol.iterator)) (10 occurrences) |
| src\components\passives\__tests__\tapped-transformer.test.ts::center_tap_voltage_is_half- N=2 (1:1 each half); AC primary; CT at midpoint | FAIL | makeResistor is not a function (33 occurrences) |
| src\components\passives\__tests__\tapped-transformer.test.ts::branchCount is 3 | FAIL | expected undefined to be 3 // Object.is equality |
| src\components\passives\mutual-inductor.ts::tapped_transformer_load_transient_parity | FAIL | Cannot read properties of undefined (reading 'states') |
| src\solver\analog\coupled-inductor.ts::voltage_ratio- N=10:1 secondary ≈ primary/10 for k=0.99 in AC steady state | FAIL | Coupling coefficient k must be in [0, 1]; got 10 |
| src\solver\analog\coupled-inductor.ts::current_ratio_inverse- secondary current ≈ N × primary branch current | FAIL | Coupling coefficient k must be in [0, 1]; got 2 (2 occurrences) |
| src\components\passives\__tests__\transformer.test.ts::winding_resistance_drops_voltage- R_pri=10Ω drops ~10V with 1A | FAIL | Cannot destructure property 'row' of 'handles[handle]' as it is undefined. |
| src\components\passives\__tests__\transformer.test.ts::branchCount is 2 | FAIL | expected undefined to be 2 // Object.is equality |
| src\components\passives\transmission-line.ts::lossless line: R_seg and G_seg stamps are zero when loss=0 | FAIL | props.hasModelParam is not a function (18 occurrences) |
| src\components\passives\__tests__\transmission-line.test.ts::requires branch row | FAIL | expected 'undefined' to be 'function' // Object.is equality |
| src\components\passives\__tests__\transmission-line.test.ts::SegmentInductorElement sub-elements declare stateSchema with 5 slots | FAIL | expected +0 to be 2 // Object.is equality (2 occurrences) |
| src\components\passives\__tests__\transmission-line.test.ts::CombinedRLElement sub-element declares stateSchema with 5 slots | FAIL | expected +0 to be 1 // Object.is equality (3 occurrences) |
| src\components\semiconductors\__tests__\diac.test.ts::triggers_triac | FAIL | createTriacElement is not a function (12 occurrences) |
| src\components\semiconductors\__tests__\diac.test.ts::definition_has_correct_fields | FAIL | expected undefined to be defined (9 occurrences) |
| (...38 more error types) | | |

## Key Failure Categories

1. **Missing test helper functions** (total 488 occurrences):
   - `makeVoltageSource` (194)
   - `withNodeIds` (119)
   - `props.getModelParam` (105)
   - `makeResistor` (33)
   - `props.hasModelParam` (18)
   - `makeAcVoltageSource` (7)
   - `props.getOrDefault` (4)
   - `solver` (4)
   - `createTriacElement` (12)

2. **Element/API initialization failures** (total 70 occurrences):
   - `el.setup is not a function` (14)
   - Handle destructuring errors (17 occurrences across multiple tests)
   - `stateBaseOffset` property setting (6)

3. **Numerical/NaN assertion failures** (total 31 occurrences):
   - Memristor tests producing NaN results (8)
   - RLC transient analysis numerical mismatches (3)
   - Various assertion value mismatches (20)

4. **Iteration/Property access errors** (total 29 occurrences):
   - `number 1/2 is not iterable` (29)
   - Undefined property reads (15)

5. **Type/Value assertion failures** (total 140+ occurrences):
   - Various expected value mismatches across multiple component types
   - Encoding/character encoding issues (1)
   - Null/undefined checks failing

## Notes

- All failures are categorized by root cause error message
- Multiple failures share the same underlying cause (e.g., missing test factories)
- Numerical failures appear concentrated in transient analysis and device model tests
- API initialization failures suggest recent refactoring or incomplete migrations
- Total occurrence count across all failures: 738 test cases failing
