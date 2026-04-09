# Test Baseline

- **Timestamp**: 2026-04-09T00:00:00Z
- **Phase**: Phase 1 (Stream 1: Data Accuracy)
- **Command**: `npm run test:q`
- **Result**: 8479/8494 passing, 15 failing, 0 skipped

## Summary

- **Vitest (Unit/Integration)**: 8002/8006 passed, 4 failed (13.8s, 346 files)
- **Playwright (E2E)**: 477/488 passed, 11 failed (176.5s, 23 files)

## Failing Tests (Pre-existing)

### Vitest Failures (4)

| Test | File | Status | Summary |
|------|------|--------|---------|
| transient stepping does not error after 50 steps | `src/solver/coordinator.ts` | FAIL | Analog engine stagnation: simTime stuck at 1.0000000000000003e-9s. Engine exhausted all internal retries without advancing. |
| survives 2000 transient steps without ERROR state | `src/solver/analog/__tests__/buckbjt-convergence.test.ts` | FAIL | Engine entered ERROR state at step 2, simTime=1.0000000000000003e-9 |
| survives 600µs of sim time (matches UI run duration) | `src/solver/analog/__tests__/buckbjt-convergence.test.ts` | FAIL | Engine ERROR at step 2, simTime=1.000e-9 |
| 50 steps advance simTime > 0 without ERROR (regression: stale t=0 breakpoints must not freeze getClampedDt) | `src/solver/analog/__tests__/buckbjt-mcp-surface.test.ts` | FAIL | step 1 transitioned engine to ERROR (simTime=1.0000000000000003e-9) |

### Playwright Failures (11)

| Test | File | Status | Summary |
|------|------|--------|---------|
| compile and step — no convergence error, supply rail is 10V | `gui/analog-bjt-convergence.spec.ts` | FAIL | Expected 0.02092469043192962 to be close to 0.02084652 (tolerance error: 0.00007817) |
| step to 5ms — output voltage evolves and trace captures transient | `gui/analog-bjt-convergence.spec.ts` | FAIL | Numeric comparison failed (toBeCloseTo) |
| DAC at bits=4: set property and compile | `gui/component-sweep.spec.ts` | FAIL | Status bar shows an error |
| DAC at bits=8: set property and compile | `gui/component-sweep.spec.ts` | FAIL | Status bar shows an error |
| ADC at bits=4: set property and compile | `gui/component-sweep.spec.ts` | FAIL | Status bar shows an error |
| ADC at bits=8: set property and compile | `gui/component-sweep.spec.ts` | FAIL | Status bar shows an error |
| Master 1: digital logic — gates, flip-flop, counter | `gui/master-circuit-assembly.spec.ts` | FAIL | Status bar shows an error |
| changing BF on BJT via primary param row changes output voltage | `gui/hotload-params-e2e.spec.ts` | FAIL | Expected 0.09577162816208429 to be close to 0.0957744513 (tolerance error: 0.0000028) |
| Master 2: analog — switched divider, RC, opamp, BJT | `gui/master-circuit-assembly.spec.ts` | FAIL | Expected less than assertion failed |
| buckbjt at 1ms/s — simTime advances at least 500us in 2s wall time | `gui/stepping-perf.spec.ts` | FAIL | simTime only advanced 0.0us — expected at least 500us |
| buckbjt fast-forward 1ms — completes within 5s wall budget | `gui/stepping-perf.spec.ts` | FAIL | FF only advanced 0.0us — expected ~1ms |

## Notes

- The majority of failures (4 vitest, 2 playwright) are related to analog engine convergence and stepping issues in the buckbjt transient analysis circuit
- 5 playwright failures are GUI status bar errors (DAC/ADC/master circuit compilation errors)
- 2 playwright failures are numeric tolerance issues in analog simulation output
- 2 playwright failures are performance/stepping advancement issues

All failures appear to be pre-existing and unrelated to Phase 1 implementation work.
