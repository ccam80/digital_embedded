# Test Baseline

- **Timestamp**: 2026-03-28T13:13:21Z
- **Phase**: Model System Unification (Wave 0 about to start)
- **Command**: `npm run test:q`
- **Result**: 10198/10257 passing, 59 failing, 0 errors

## Test Summary
- **Vitest (unit/integration)**: 9720/9730 passed (10 failed)
- **Playwright (E2E)**: 478/527 passed (49 failed)
- **Total duration**: ~246 seconds (vitest: 15.3s, playwright: 228.6s)

## Failing Tests (pre-existing)

### Unit/Integration Failures (Vitest)

| Test Path | Status | Summary |
|-----------|--------|---------|
| `src/headless/__tests__/spice-model-overrides-mcp.test.ts::patch with _spiceModelOverrides changes DC operating point vs default` | FAIL | Assertion failed: expected false to be true (line 165) |
| `src/components/semiconductors/__tests__/*.test.ts::peak_current_at_vp` | ERROR | IS_THERMAL is not defined (line 74) |
| `src/components/semiconductors/__tests__/*.test.ts::valley_current_at_vv` | ERROR | IS_THERMAL is not defined (line 74) |
| `src/components/semiconductors/__tests__/*.test.ts::negative_resistance_region` | ERROR | IS_THERMAL is not defined (line 74) |
| `src/components/semiconductors/__tests__/*.test.ts::i_v_curve_shape` | ERROR | IS_THERMAL is not defined (line 74) |
| `src/components/semiconductors/__tests__/*.test.ts::nr_converges_in_ndr_region` | ERROR | Cannot read properties of undefined (reading 'IP') (line 122) |

### E2E Failures (Playwright) by Category

| Category | Count | Issue |
|----------|-------|-------|
| Amplitude/frequency assertions (toBeGreaterThanOrEqual) | 7 | Signal values below expected threshold in RC/RLC/555 timer/mixed circuits |
| Current/voltage transient assertions (toBeGreaterThan) | 13 | Transient response too slow or converging slowly |
| SPICE model property CSS parsing | 13 | Special characters in JSON property strings break Playwright CSS selector escaping (IS, VTO, BETA, LAMBDA, KP, W, L parameters) |
| Zener regulator convergence | 1 | Vregulated measured as 0V instead of expected 5.14V ±0.1% |
| SCR/LDR assertion (toBeLessThan) | 2 | Values exceed expected threshold |
| Test timeouts (30s exceeded) | 2 | triac dimmer E2E test, PWM counter E2E test |
| RC transient: no node voltage change | 1 | 50 simulation steps produced no voltage evolution |
| App load: net::ERR_ABORTED | 1 | Localhost connection failure during canvas renders test |
| Status bar compilation errors | 7 | DAC/ADC/OpAmp/Comparator tests fail to compile (domain/bridge issues) |
| Digital ripple counter assertion (toBe) | 1 | T flip-flop 4-bit counter state mismatch |
| SPICE panel: value persistence | 1 | Edited IS value not found after popup reopen |

## Notes

- **Pre-existing failures**: All 59 failures are pre-existing and represent the baseline state before Wave 0.
- **Primary issue clusters**:
  1. **Transient simulation accuracy**: Many analog tests expect specific voltage/current evolution rates that are too strict (13 tests)
  2. **SPICE model property UI**: Property JSON strings contain special characters that confuse Playwright CSS selector parsing (13 tests)
  3. **Convergence/stability**: Mixed-signal circuits (DAC, ADC, comparator) show compilation or convergence issues (7 tests)
  4. **Tunnel diode model definition**: Missing or undefined thermal constants (5 tests)
  5. **Test infrastructure**: Timeouts and connection issues in 2 tests

## Baseline Established

This baseline captures the pre-Wave 0 state. Wave 0 should not introduce new failures beyond these 59 pre-existing issues.
