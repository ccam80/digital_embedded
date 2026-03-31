# Test Baseline

- **Timestamp**: 2026-03-31T00:00:00Z
- **Phase**: Pre-implementation baseline
- **Command**: `npx playwright test e2e/gui/master-circuit-assembly.spec.ts`
- **Result**: 1/3 passing, 2 failing, 0 errors

## Failing Tests (pre-existing)

| Test | Status | Summary |
|------|--------|---------|
| Master 2: analog — switched divider, RC, opamp, BJT | FAIL | Peak voltage assertion failed: expected > 2.0V but received 0.000009999980000040001V (analog circuit simulation issue) |
| Master 3: mixed-signal — DAC, RC, comparator, counter | FAIL | Property popup element not found when attempting to set Voltage (V) input (UI interaction issue) |

## Test Details

### Passing Tests
1. **Master 1: digital logic — gates, flip-flop, counter** - 4.1s

### Failing Tests Details

**Master 2: analog — switched divider, RC, opamp, BJT** (5.2s)
- Error at line 249 in `e2e/gui/master-circuit-assembly.spec.ts`
- Expected peak voltage > 2.0V but got 0.000009999980000040001V
- Issue: Analog circuit is not simulating properly; voltage divider not reaching expected peak

**Master 3: mixed-signal — DAC, RC, comparator, counter** (5.7s)
- Error at line 301 in `e2e/gui/master-circuit-assembly.spec.ts`
- Timeout waiting for voltage input element to be visible in property popup
- Issue: UI element locator failed to find `.prop-popup` with "Voltage (V)" label after 2000ms
