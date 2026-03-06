# Test Baseline

- **Timestamp**: 2026-03-06T20:07:26Z
- **Phase**: fix-spec remediation
- **Command**: `npm test` (runs `vitest run`)
- **Result**: 4454/4455 passing, 0 failing, 0 errors (1 skipped)

## Summary

Full test suite execution completed successfully. All 190 test files passed with 4454 passing tests and 1 skipped test. No failures or errors detected.

### Test Results by Category

| Category | File Count | Test Count | Status |
|----------|-----------|-----------|--------|
| Components | 45 | 1850+ | All passing |
| Engine | 16 | 250+ | All passing |
| Analysis | 19 | 300+ | All passing |
| I/O & Parsing | 18 | 400+ | All passing |
| Editor & UI | 30 | 600+ | All passing |
| Runtime & Export | 15 | 250+ | All passing |
| HGS & Scripting | 8 | 200+ | All passing |
| Testing Framework | 10 | 150+ | All passing |
| Integration | 8 | 100+ | All passing |
| Utilities | 15+ | 300+ | All passing |

## Test Execution Notes

- **Total Test Files**: 190
- **Total Tests**: 4455
- **Passing**: 4454
- **Skipped**: 1 (src/headless/__tests__/integration.test.ts)
- **Failing**: 0
- **Errors**: 0
- **Total Duration**: 21.89s

### Minor Warnings (Non-blocking)

The following stderr messages appeared during test execution but did not cause test failures:

1. **i18n tests**: Expected error messages logged when testing error handling in locale loading
2. **Canvas-related tests**: "Not implemented: HTMLCanvasElement's getContext()" — jsdom limitation, tests still pass with mocked canvas
3. **i18n.test.ts**: Expected "Failed to load locale" errors when testing invalid locale handling

All warnings are intentional test output (error handling verification) and do not indicate test failures.

## Baseline Established

This baseline represents a healthy test suite with 100% test file pass rate and no active defects. Suitable for tracking regressions and validating fix-spec remediation work.
