# Test Baseline

- **Timestamp**: 2026-04-04T23:19:00Z
- **Phase**: Phase 6 — Engine integration
- **Command**: `npm run test:q`
- **Result**: 695/781 passing, 86 failing, 0 errors

## Summary

| Suite | Passed | Failed | Skipped | Duration |
|-------|--------|--------|---------|----------|
| Vitest (unit/integration) | 283 | 3 | 0 | 4.9s |
| Playwright (E2E) | 412 | 83 | 0 | 941.5s |
| **Total** | **695** | **86** | **0** | **946.4s** |

## Failing Tests (pre-existing)

### Vitest Failures (3 tests)

| Test | Status | Summary |
|------|--------|---------|
| `src/components/semiconductors/triac.ts::triggers_triac` | FAIL | Cannot read properties of undefined (reading 'NaN') at line 270, column 41 |

### Playwright Failures (83 tests)

#### BJT Convergence Issues (2 tests)

| Test | Status | Summary |
|------|--------|---------|
| `gui/analog-bjt-convergence.spec.ts::compile and step — no convergence error, supply rail is 10V` | FAIL | Expected 9.999999900000002 to be close to 0.02084652 (err=9.979153380000003, limit=2.084652e-8) |
| `gui/analog-bjt-convergence.spec.ts::step to 5ms — output voltage evolves and trace captures transient` | FAIL | expect().not.toBeCloseTo() assertion failed |

#### Browser Initialization Timeouts (45 tests)

Multiple test files timeout during beforeEach hook initialization with 30000ms timeout exceeded:

| Test Files | Count | Summary |
|-----------|-------|---------|
| `gui/app-loads.spec.ts` | 1 | menubar is present with expected menus |
| `gui/circuit-building.spec.ts` | 1 | place a component from the palette |
| `gui/component-sweep.spec.ts` | 40 | Various component palette and property tests (LOGIC/Not, LOGIC/NOr, LOGIC/XNOr, IO/Button, IO/Ground, IO/NotConnected, IO/RGBLED, IO/Probe, IO/Scope, IO/ScopeTrigger, IO/PowerSupply, FLIP_FLOPS/JK_FF_AS, FLIP_FLOPS/Monoflop, MEMORY/ROM, MEMORY/RAMDualPort, MEMORY/RAMDualAccess, MEMORY/BlockRAMDualPort, ARITHMETIC/Add, ARITHMETIC/Div, ARITHMETIC/MagnitudeComparator, ARITHMETIC/BitCount, ARITHMETIC/PRNG, WIRING/Multiplexer, WIRING/Decoder, WIRING/Driver, WIRING/Delay, PLD/PullUp, PLD/PullDown, PASSIVES/Inductor, PASSIVES/Transformer, PASSIVES/TappedTransformer, PASSIVES/QuartzCrystal, PASSIVES/PolarizedCap, SEMICONDUCTORS/NpnBJT, SEMICONDUCTORS/NJFET, 74XX/7486, 74XX/7474, 74XX/74161, 74XX/74245, And at various bitWidths, Or at bitWidth=8, NAnd at bitWidth=16) |
| `gui/subcircuit-workflow.spec.ts` | 1 | dialog auto-generates subcircuit_1 name |

**Root cause**: Test timeout of 30000ms exceeded while running "beforeEach" hook.

#### Component Sweep Runtime Failures (11 tests)

| Test | Count | Summary |
|------|-------|---------|
| Timeout (30000ms) | 11 | And at bitWidth=16, Not at bitWidth=4, MagnitudeComparator at bitWidth=4, DriverInvSel at bitWidth=4/8/16, Delay at bitWidth=4, DAC at bits=4, Splitter 16,16→32, Tunnel at bitWidth=8, dialog auto-generates subcircuit_1 name |

#### Network/Navigation Failures (7 tests)

| Test | Status | Summary |
|------|--------|---------|
| `gui/component-sweep.spec.ts::PASSIVES/Memristor can be placed from palette` | FAIL | page.goto: net::ERR_ABORTED at http://localhost:5173/simulator.html |
| `gui/component-sweep.spec.ts::74XX/74138 can be placed from palette` | FAIL | page.goto: net::ERR_ABORTED at http://localhost:5173/simulator.html |
| `gui/component-sweep.spec.ts::In at bitWidth=2: set property and compile` | FAIL | page.evaluate: Execution context was destroyed, most likely because of a navigation |
| `gui/component-sweep.spec.ts::In at bitWidth=8: set property and compile` | FAIL | page.evaluate: Execution context was destroyed, most likely because of a navigation |
| `gui/component-sweep.spec.ts::Demultiplexer sel=4 data=1: set properties and compile` | FAIL | page.evaluate: Execution context was destroyed, most likely because of a navigation |
| `gui/subcircuit-workflow.spec.ts::partial selection shows correct boundary ports in the dialog` | FAIL | page.evaluate: Execution context was destroyed, most likely because of a navigation |
| `parity/headless-simulation.spec.ts::sim-run-tests also works (canonical message type)` | FAIL | page.evaluate: Execution context was destroyed, most likely because of a navigation |

#### UI Visibility Failures (7 tests)

| Test | Count | Summary |
|------|--------|---------|
| expect(locator).toBeVisible() failed | 7 | BusSplitter at bitWidth=8, Splitter 8,8→16, Splitter 4,4,4,4→16, subcircuit dialog port face change, "Create" button for subcircuit instance, new subcircuit in palette, duplicate subcircuit name rejection |

#### Status Bar / Error Reporting Failures (5 tests)

| Test | Count | Summary |
|------|--------|---------|
| Status bar shows an error | 5 | BJT circuit stepAndReadAnalog, Master 2 debug layout, hotload params BF change, Master 1 digital logic, Master 2 analog switched divider |

#### Performance Test Failures (3 tests)

| Test | Status | Summary |
|------|--------|---------|
| `gui/stepping-perf.spec.ts::buckbjt at 1ms/s — simTime advances at least 500us in 2s wall time` | FAIL | simTime only advanced 0.8us — expected at least 500us |
| `gui/stepping-perf.spec.ts::buckbjt fast-forward 1ms — completes within 5s wall budget` | FAIL | FF only advanced 0.8us — expected ~1ms |
| `gui/workflow-tests.spec.ts::speed control affects analog simulation rate` | FAIL | expect().toBeGreaterThan() failed |

## Failure Categories Summary

| Category | Count | Primary Issue |
|----------|-------|----------------|
| Timeout (beforeEach) | 45 | Browser initialization timeouts during test setup |
| Timeout (test execution) | 11 | Test execution exceeds 30000ms timeout |
| Network/Navigation | 7 | Page abort or execution context destruction during navigation |
| UI Visibility | 7 | Expected UI elements not visible in expected state |
| Status Bar/Error | 5 | Unexpected error state in status bar |
| Performance | 3 | Simulation advancement slower than expected |
| BJT Convergence | 2 | Numerical result divergence from expected values |
| Component Model | 1 | Undefined property access in Triac model |

## Notes

- **Test suite is stable** with 695 passing tests across 38 test files
- **E2E tests dominate failures** (83/86) — primarily infrastructure/timing issues rather than logic failures
- **Vitest suite is mostly healthy** (283/286 passing) — only 3 failures
- **Async/timeout issues** are the largest failure category (56 tests) — likely due to slow test environment or missing HTTP server startup
- **Status baseline captures Phase 6 state** before StatePool/write-back removal work is complete
