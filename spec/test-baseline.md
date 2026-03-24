# Test Baseline

- **Timestamp**: 2026-03-25T12:18:47Z
- **Phase**: Phase 0 + Phase 1 (unified component architecture)
- **Command**: `npm test`
- **Result**: 7386/7386 passing, 0 failing, 0 errors

## Summary

All 327 test files passed successfully with 7386 individual test cases passing. No pre-existing failures detected.

### Test Execution Details

- **Total Test Files**: 327
- **Total Tests**: 7386
- **Passed**: 7386
- **Failed**: 0
- **Errors**: 0
- **Total Duration**: 35.34s
  - Transform: 13.49s
  - Collection: 50.55s
  - Test execution: 34.62s
  - Environment: 5.60s
  - Prepare: 71.40s

## Test Coverage by Component

The test suite covers all major subsystems:

| Subsystem | Test File | Status |
|-----------|-----------|--------|
| Core Logic Gates | `src/components/basic/__tests__/function.test.ts` | PASS (73 tests) |
| Memory Components | `src/components/memory/__tests__/ram.test.ts` | PASS (105 tests) |
| PLD (Programmable Logic) | `src/components/pld/__tests__/pld.test.ts` | PASS (135 tests) |
| Arithmetic | `src/components/arithmetic/__tests__/arithmetic.test.ts` | PASS (130 tests) |
| Arithmetic Utils | `src/components/arithmetic/__tests__/arithmetic-utils.test.ts` | PASS (99 tests) |
| FETs (Switching) | `src/components/switching/__tests__/fets.test.ts` | PASS (56 tests) |
| Switches | `src/components/switching/__tests__/switches.test.ts` | PASS (89 tests) |
| I/O Components | `src/components/io/__tests__/io.test.ts` | PASS (102 tests) |
| LED Display | `src/components/io/__tests__/led.test.ts` | PASS (84 tests) |
| Flip-Flops | `src/components/flipflops/__tests__/flipflops.test.ts` | PASS (100 tests) |
| Transmission Line | `src/components/passives/__tests__/transmission-line.test.ts` | PASS (26 tests) |
| Timer 555 | `src/components/active/__tests__/timer-555.test.ts` | PASS (8 tests) |
| MNA (Analog) | `src/analog/__tests__/mna-end-to-end.test.ts` | PASS (15 tests) |
| CMOS Gates (Analog) | `src/analog/__tests__/cmos-gates.test.ts` | PASS (14 tests) |
| Circuit Compiler | `src/engine/__tests__/compiler.test.ts` | PASS (23 tests) |
| CMOS Inverter | `src/engine/__tests__/cmos-inverter.test.ts` | PASS (1 test) |
| Timing Diagram | `src/runtime/__tests__/timing-diagram.test.ts` | PASS (20 tests) |
| Data Table | `src/runtime/__tests__/data-table.test.ts` | PASS (17 tests) |
| Measurement Order | `src/runtime/__tests__/measurement-order.test.ts` | PASS (27 tests) |
| Truth Table UI | `src/analysis/__tests__/truth-table-ui.test.ts` | PASS (3 tests) |
| Context Menu | `src/editor/__tests__/context-menu.test.ts` | PASS (8 tests) |
| Tutorial Host | `src/tutorial/__tests__/tutorial-host.test.ts` | PASS (25 tests) |
| Orphan Diagnosis | `src/io/__tests__/inv_rot_test.test.ts` | PASS (3 tests) |
| FSM Hit Test | `src/fsm/__tests__/fsm-hit-test.test.ts` | PASS (2 tests) |
| Headless Fence | `src/headless/__tests__/fence.test.ts` | PASS (1 test) |
| Legacy Audit | `src/__tests__/legacy-audit.test.ts` | PASS (4 tests) |

### Notes

- No test failures or errors detected
- All subsystems are operational
- Legacy audit tests confirm no stale references to old systems (CheerpJ, Digital.jar, xstream, Java package names, or JVM references)
- HTML Canvas-related warnings in timing diagram tests are expected (getContext() requires canvas npm package mock, but tests pass regardless)
- Complete baseline established for all 327 test files covering Phase 0 and Phase 1 architecture
