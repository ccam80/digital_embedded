# Test Baseline

- **Timestamp**: 2026-03-19T14:22:55Z
- **Phase**: Facade Unification (one-off)
- **Command**: `npm test` (vitest run)
- **Result**: 6782/6791 passing, 9 failing, 0 errors

## Summary Statistics

| Metric | Count |
|--------|-------|
| Test Files Passing | 314 |
| Test Files Failing | 4 |
| Total Test Files | 318 |
| Total Tests Passing | 6782 |
| Total Tests Failing | 9 |
| Total Tests | 6791 |
| Duration | 65.48s |

## Failing Tests (pre-existing)

| Test File | Test Suite | Test Name | Status | Summary |
|-----------|-----------|-----------|--------|---------|
| src/components/io/__tests__/io.test.ts | ConstComponent > execute | executeConst preserves the pre-initialised output value | FAIL | Expected 48879 (0xBEEF), got 1 — output value not preserved |
| src/components/io/__tests__/io.test.ts | ConstComponent > execute | executeConst with value 0 leaves output as 0 | FAIL | Expected 0, got 1 — output value not cleared |
| src/headless/__tests__/stress-test-regressions.test.ts | BUG-2: Splitter executeFn ignores port widths | executeSplitter should split 16-bit value into two 8-bit halves | FAIL | Expected 205 (0xCD), got 1 — port width mismatch in output |
| src/fixtures/__tests__/shape-render-audit.test.ts | shape render audit | summary: shape comparison results | FAIL | 34 detached pins across 13 analog components (VCVS, VCCS, CCVS, CCCS, OTA, DcVoltageSource, CurrentSource, AcVoltageSource, VariableRail, Timer555, RealOpAmp, OpAmp, AnalogSwitchSPDT) |
| src/fixtures/__tests__/shape-render-audit.test.ts | shape render audit | Text overlap validation (6 tests) | FAIL | Text positioning/overlap issues in shape pixel comparisons vs Java Digital reference |

## Notes

- All 9 failures are pre-existing defects unrelated to Facade Unification phase
- ConstComponent regressions (2 tests): executeFn not writing output values correctly
- Splitter regression (1 test): Known issue with port width handling in executeFn
- Shape render audit failures (6 tests):
  - Detached pins in analog component shape definitions (34 pins across 13 components)
  - Text overlap validation failures in pixel-level rendering comparisons
- Test execution successful; failures are legitimate test assertions catching real bugs
- Improvement vs Phase 6: 227 additional tests added (6555 → 6782), test files grew from 302 to 318
- 3 pre-existing fixture-audit failures from Phase 6 are no longer present (likely replaced by shape-render-audit)
