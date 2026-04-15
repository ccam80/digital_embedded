# Test Baseline

- **Timestamp**: 2026-04-15T21:58:00Z
- **Phase**: Phase 0 (baseline capture)
- **Command**: npm run test:q
- **Result**: 8333/8368 passing, 35 failing, 0 errors

## Summary

Total tests: 8368 across 365 files
Duration: 17.9 seconds

## Failing Tests (pre-existing)

| Test File | Test Name | Error Type | Summary |
|-----------|-----------|-----------|---------|
| src/editor/__tests__/wire-current-resolver.test.ts | cross-component current equality through real compiled lrctest.dig | Assertion | expected 0.0108 to be greater than 0.045 |
| src/editor/__tests__/wire-current-resolver.test.ts | component-as-node KCL: wire at pin A ≈ wire at pin B ≈ body current | Assertion | expected 272.02 to be less than 0.01 |
| src/headless/__tests__/rlc-lte-path.test.ts | RC step response: exponential charging matches V(1-e^-t/τ) | Assertion | expected 6.2e+30 to be ≤ 3.22 |
| src/headless/__tests__/rlc-lte-path.test.ts | RL step response: V_R matches 1-e^-t/τ (R=10, L=1mH, τ=100µs) | Assertion | expected 2.2e+6 to be ≤ 0.64 |
| src/headless/__tests__/rlc-lte-path.test.ts | series RLC ring-down: oscillatory with strictly decreasing envelope | Engine Stagnation | simTime stuck at 0.001217s |
| src/headless/__tests__/rlc-lte-path.test.ts | reltol configurability: tight reltol produces different result and more steps | Engine Stagnation | simTime stuck at 0.0000348s |
| src/headless/__tests__/rlc-lte-path.test.ts | RC capacitor zero-crossings at f=20Hz (f<<fc): 2±1 crossings and peak≥0.95 | Assertion | expected 99 to be ≤ 3 |
| src/headless/__tests__/rlc-lte-path.test.ts | RL resistor zero-crossings at f=200Hz (f<<fc): ≥6 crossings over 4 periods | Engine Stagnation | simTime stuck at 0.0093s |
| src/io/dts-schema.ts | circuit.metadata.models entry survives serialize -> deserialize | Schema Validation | modelParamDeltas.params["ICVBE"] must be number or string (6 tests) |
| src/io/dts-schema.ts | deserialized circuit with metadata.models compiles cleanly | Schema Validation | modelParamDeltas.params["ICVBE"] must be number or string |
| src/io/dts-schema.ts | deserialized circuit produces same DC result as pre-serialization | Schema Validation | modelParamDeltas.params["ICVBE"] must be number or string |
| src/io/dts-schema.ts | serialize → deserialize preserves SPICE model name and params | Schema Validation | modelParamDeltas.params["ICVBE"] must be number or string |
| src/io/dts-schema.ts | overrides survive serialize -> deserialize -> recompile | Schema Validation | modelParamDeltas.params["ICVBE"] must be number or string |
| src/io/dts-schema.ts | deserialized circuit with overrides produces same DC result as pre-serialization | Schema Validation | modelParamDeltas.params["ICVBE"] must be number or string |
| src/components/active/__tests__/timer-555.test.ts | oscillates_at_correct_frequency | Assertion | expected 0 to be ≥ 8 |
| src/components/active/__tests__/timer-555.test.ts | duty_cycle | Assertion | expected 1 to be < 0.05 |
| src/components/active/__tests__/timer-555.test.ts | pulse_width | Assertion | expected 0.9998 to be < 0.1 (2 tests) |
| src/components/active/__tests__/timer-555.test.ts | retrigger_ignored_during_pulse | Assertion | expected 0.9998 to be < 0.1 |
| src/components/sources/__tests__/ac-voltage-source.test.ts | rc_lowpass | Assertion | expected Infinity to be < 0.864 |
| src/solver/analog/__tests__/analog-engine.test.ts | transient_rc_decay | Assertion | expected -1.44e+18 to be > 4.5 (3 tests) |
| src/solver/analog/__tests__/analog-engine.test.ts | predictor_off_rc_regression | Assertion | expected -1.44e+18 to be > 4.5 |
| src/solver/analog/__tests__/convergence-regression.test.ts | RC circuit runs transient steps stably with capacitor near Vs | Assertion | expected -1.44e+18 to be > 4.5 |
| src/solver/analog/__tests__/buckbjt-convergence.test.ts | DC operating point converges | Assertion | expected false to be true (Object.is equality) |
| src/solver/analog/__tests__/buckbjt-mcp-surface.test.ts | DC op result after compile has converged === true and all finite node voltages | Assertion | expected false to be true (Object.is equality) |
| src/solver/coordinator.ts | transient stepping does not error after 50 steps | Engine Stagnation | simTime stuck at 1.25e-10s |
| src/solver/analog/__tests__/buckbjt-convergence.test.ts | survives 2000 transient steps without ERROR state | Engine Error | ERROR state at step 2, simTime=1.25e-10 |
| src/solver/analog/__tests__/buckbjt-convergence.test.ts | survives 600µs of sim time (matches UI run duration) | Engine Error | ERROR state at step 2, simTime=1.25e-10 |
| src/solver/analog/__tests__/mna-end-to-end.test.ts | rc_steady_state_no_drift | Assertion | expected 2.86e+46 to be < 0.1 |
| src/solver/analog/__tests__/mna-end-to-end.test.ts | rc_steady_state_current_zero | Assertion | expected 2.98e+42 to be < 0.01 |
| src/solver/analog/__tests__/mna-end-to-end.test.ts | rl_dc_steady_state_tight_tolerance | Assertion | expected 0.691 to be < 0.1 |
| src/solver/analog/__tests__/rc-ac-transient.test.ts | steady-state amplitude matches analytical \|H(f)\| | Assertion | expected Infinity to be < 4.445 |
| src/solver/analog/__tests__/rc-ac-transient.test.ts | output amplitude is attenuated relative to input | Assertion | expected Infinity to be < 4.999 |
| src/solver/analog/__tests__/rc-ac-transient.test.ts | output phase lags input | Assertion | expected true to be false (Object.is equality) |
| src/solver/analog/__tests__/rc-ac-transient.test.ts | higher frequency produces greater attenuation | Assertion | expected 1.99e+161 to be < 2.116 |
| src/solver/analog/__tests__/rc-ac-transient.test.ts | full pipeline: compile → DC OP → transient → analytical match | Assertion | expected 4.9999 to be < 4.657 |

## Failure Categories

| Category | Count | Details |
|----------|-------|---------|
| Numerical/Convergence Issues | 8 | Infinity values, extreme values (e+30, e+42, e+46, e+161) suggesting NaN propagation or solver instability |
| Engine Stagnation | 4 | Timestep unable to advance; check convergence log (see CLAUDE.md) |
| Engine Error | 2 | ERROR state during transient simulation |
| Schema Validation | 6 | modelParamDeltas serialization format issue with ICVBE parameter |
| Oscillator/Timing | 5 | 555 timer and AC source behavioral assertions failing |
| RLC/Dynamics | 6 | Step response, zero-crossing, and AC frequency response failures |
| DC Convergence | 2 | BJT buck converter DC operating point not converging |
| Wire Current Analysis | 2 | KCL and current equality checks |

## Structured Failure Data

Complete structured failure data available in `.vitest-failures.json` with file paths, line numbers, and error messages.
