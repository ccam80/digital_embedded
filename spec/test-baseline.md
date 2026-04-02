# Test Baseline

- **Timestamp**: 2026-04-02T11:22:35Z
- **Phase**: Phase 1 — Domain Leak Fix
- **Command**: `npm run test:q`
- **Result**: 10410/10421 passing, 11 failing, 0 errors

## Failing Tests (pre-existing)

| Test | File | Status | Summary |
|------|------|--------|---------|
| compile and step — no convergence error, supply rail is 10V | e2e/gui/analog-bjt-convergence.spec.ts:251 | FAIL | Numeric assertion: Expected 9.999999899999734 to be close to 0.02084652 (error margin exceeded) |
| step to 5ms — output voltage evolves and trace captures transient | e2e/gui/analog-bjt-convergence.spec.ts:387 | FAIL | Assertion failed: received value should not be close to expected |
| ACTIVE/SwitchSPST can be placed from palette | e2e/gui/component-sweep.spec.ts:500 | ERROR | Test timeout of 30000ms exceeded in beforeEach hook |
| ACTIVE/VCCS can be placed from palette | e2e/gui/component-sweep.spec.ts:500 | ERROR | Test timeout of 30000ms exceeded in beforeEach hook |
| ACTIVE/CCCS can be placed from palette | e2e/gui/component-sweep.spec.ts:500 | ERROR | Test timeout of 30000ms exceeded in beforeEach hook |
| GRAPHICS/LedMatrix can be placed from palette | e2e/gui/component-sweep.spec.ts:500 | ERROR | Test timeout of 30000ms exceeded in beforeEach hook |
| GRAPHICS/VGA can be placed from palette | e2e/gui/component-sweep.spec.ts:500 | ERROR | Test timeout of 30000ms exceeded in beforeEach hook |
| GRAPHICS/GraphicCard can be placed from palette | e2e/gui/component-sweep.spec.ts:500 | ERROR | Test timeout of 30000ms exceeded in beforeEach hook |
| ACTIVE/VCVS can be placed from palette | e2e/gui/component-sweep.spec.ts:500 | ERROR | Network error: net::ERR_NETWORK_IO_SUSPENDED at http://localhost:5173/simulator.html |
| TERMINAL/Keyboard can be placed from palette | e2e/gui/component-sweep.spec.ts:500 | ERROR | Network error: net::ERR_NETWORK_IO_SUSPENDED at http://localhost:5173/simulator.html |
| changing BF on BJT via primary param row changes output voltage | e2e/gui/hotload-params-e2e.spec.ts:103 | FAIL | Numeric assertion: Expected 0.09137728610279339 to be close to 0.0957744513 (error margin exceeded) |

## Test Summary

- **Vitest** (unit/integration): 9932/9932 passing (100%), 11.7s
- **Playwright** (E2E): 478/489 passing (97.75%), 199.7s
  - 3 analog BJT/hotload numeric assertion failures
  - 6 component-sweep timeouts in beforeEach
  - 2 component-sweep network errors
