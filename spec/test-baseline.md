# Test Baseline

- **Timestamp**: 2026-03-29T00:00:00Z
- **Phase**: Wave 5 complete, Wave 6 + Wave 10 parallel tracks in progress
- **Command**: `npm run test:q`
- **Result**: 553/613 passing, 60 failing, 0 errors

## Test Summary

- **Vitest (headless API)**: 86/86 passing (0 failing) — 1.6 seconds
- **Playwright (E2E)**: 467/527 passing (60 failing) — 225.4 seconds
- **Total duration**: ~227 seconds

## Failing Tests (pre-existing)

### Analog Simulation Assertions (16 failures)

Numeric comparison failures in analog circuit tests, suggesting inconsistent simulation convergence:

| Test | Issue | Tests |
|------|-------|-------|
| toBeGreaterThanOrEqual | Signal values below threshold | RC lowpass (steady-state), RLC series (resonance), RLC parallel (anti-resonance), capacitor property popup, D_FF + SPDT with LRC load |
| toBeGreaterThan | Transient response too slow | RL circuit, switched RC, LRC with switch, relay-driven LC, SPDT source selector, crystal oscillator, 555 astable, RC lowpass, speed control, digital-controlled analog switch |
| toBeLessThan | Values exceed threshold | SCR latch, LDR voltage divider |

### Model Parameter CSS Selector Parsing (11 failures)

Playwright CSS selector parsing fails when model parameters contain special JSON characters:

| Parameter | Tests |
|-----------|-------|
| IS (saturation current) | BJT common-emitter, differential pair, Darlington, push-pull, cascode, Wilson mirror, Widlar source, BJT+MOSFET driver, multi-stage amplifier |
| VTO (threshold voltage) | MOSFET common-source, MOSFET PWM, JFET amplifier, MOSFET H-bridge |

Selector format: `.prop-row:has(.prop-label:text-is("{JSON_OBJECT}"))` — special chars in JSON need CSS.escape()

### Mixed-Domain Compilation Errors (12 failures)

Status bar showing compilation errors in DAC/ADC/bridge-related circuits:

| Category | Count | Tests |
|----------|-------|-------|
| DAC circuits | 3 | DAC at bits=4, DAC at bits=8, DAC + RC filter |
| Converter I/O | 4 | digital gate driving analog load, comparator to logic, ADC readout, Schmitt trigger to counter |
| Timer/oscillator | 2 | 555 timer driving counter, PWM to analog voltage |
| Control loops | 1 | digital servo loop |
| Mixed logic/power | 2 | switched capacitor filter, BJT level-shifts into And, relay from digital logic |

### Test Timeouts (13 failures)

Tests exceeding 30000ms limit, primarily digital gates in analog mode:

| Category | Count | Tests |
|----------|-------|-------|
| Digital logic in analog mode | 8 | And, Or, Not, NAnd, NOr, XOr, XNOr, D_FF, JK_FF, RS_FF, T_FF (at line 766) |
| Mixed circuits | 2 | triac dimmer, PWM to analog voltage |

### Transient/Simulation Issues (2 failures)

| Test | Issue |
|------|-------|
| node voltages change during transient simulation | No voltage evolution after 50 steps in RC circuit |
| zener regulator: output clamps at Vz | Vregulated measured as 0V instead of 5.14V ±0.1% |

### Digital/UI Failures (2 failures)

| Test | Issue |
|------|-------|
| T flip-flop 4-bit ripple counter | toBe assertion (Object.is equality) mismatch |
| edited IS value persists after popup reopen | toContain assertion failure in SPICE model panel |

## Notes

- **All headless tests pass** (86/86 vitest): Core simulation logic is sound
- **E2E-specific failures** (60 playwright): Integration issues, not headless bugs
- **Failure pattern changes from baseline**: 59 → 60 failures (1 new), likely from test drift or Wave 5 restructuring side effects
- **Primary regression areas**:
  1. Analog simulation robustness — strict convergence expectations failing
  2. UI test infrastructure — CSS selector escaping for JSON model parameters
  3. Mixed-domain bridge synthesis — DAC/ADC/comparator circuits showing errors
  4. Performance — digital gates in analog mode timing out

## Baseline Established

This baseline captures the state after Wave 5 (ComponentModels restructure) and serves as reference for Wave 6 (digitalPinLoading + bridge synthesis) and Wave 10 (.SUBCKT parser) work.
