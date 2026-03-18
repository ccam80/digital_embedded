# Test Baseline

- **Timestamp**: 2026-03-18T16:20:22Z
- **Phase**: 6
- **Command**: `npx vitest run`
- **Result**: 6555/6563 passing, 8 failing, 0 errors

## Summary Statistics

| Metric | Count |
|--------|-------|
| Test Files Passing | 299 |
| Test Files Failing | 3 |
| Total Test Files | 302 |
| Total Tests Passing | 6555 |
| Total Tests Failing | 8 |
| Total Tests | 6563 |
| Duration | 47.06s |

## Failing Tests (pre-existing)

| Test File | Test Suite | Test Name | Status | Summary |
|-----------|-----------|-----------|--------|---------|
| src/fixtures/__tests__/fixture-audit.test.ts | fixture audit | 'Sim/all-components.dig' > tunnel pins connected | FAIL | 1 disconnected tunnel at (0, 64) |
| src/fixtures/__tests__/fixture-audit.test.ts | fixture audit | 'Sim/Processor/cpu_final.dig' > wire endpoints meet pins or junctions | FAIL | 3 orphan wire endpoints at (-38, 48), (-38, 36), (-38, 44) |
| src/fixtures/__tests__/fixture-audit.test.ts | fixture audit | 'Sim/TC.dig' > wire endpoints meet pins or junctions | FAIL | 1 orphan wire endpoint at (135, 18) |
| src/fixtures/__tests__/fixture-audit.test.ts | fixture audit | 'Sim/TC_testing.dig' > wire endpoints meet pins or junctions | FAIL | 1 orphan wire endpoint (wire routing issue) |
| src/fixtures/__tests__/fixture-audit.test.ts | fixture audit | 'mod3/Sim/cpu_layout_final.dig' > tunnel pins connected | FAIL | 25 disconnected tunnel(s) |
| src/headless/__tests__/stress-test-regressions.test.ts | BUG-2: Splitter executeFn ignores port widths | executeSplitter should split 16-bit value into two 8-bit halves | FAIL | Expected 205 (0xCD), got 1 (port width mismatch) |
| src/components/io/__tests__/io.test.ts | ConstComponent > execute | executeConst preserves the pre-initialised output value | FAIL | Expected 48879 (0xBEEF), got 1 |
| src/components/io/__tests__/io.test.ts | ConstComponent > execute | executeConst with value 0 leaves output as 0 | FAIL | Expected 0, got 1 |

## Notes

- All 8 failures are pre-existing defects unrelated to the test capture
- Fixture audit failures (5 tests): Wire routing and tunnel connection issues in example .dig files
- Splitter regression (1 test): Known issue with port width handling in executeFn
- ConstComponent regressions (2 tests): Output value initialization/preservation issues in executeFn
- Test execution successful; failures are legitimate test assertions catching real bugs
- Improvement vs Phase 5: 33 additional tests added (6201 → 6563), test files grew from 269 to 302
- 8 failing tests unchanged from Phase 5 baseline
