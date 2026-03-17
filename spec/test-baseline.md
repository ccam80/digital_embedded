# Test Baseline

- **Timestamp**: 2026-03-18T11:30:41Z
- **Phase**: 4c (Transistor-Level Models)
- **Command**: `npm test` (vitest run)
- **Result**: 6152/6163 passing, 11 failing, 0 errors

## Summary Statistics

| Metric | Count |
|--------|-------|
| Test Files Passing | 260 |
| Test Files Failing | 5 |
| Total Test Files | 265 |
| Total Tests Passing | 6152 |
| Total Tests Failing | 11 |
| Total Tests | 6163 |
| Duration | 35.61s |

## Failing Tests (pre-existing)

| Test File | Test Suite | Test Name | Status | Summary |
|-----------|-----------|-----------|--------|---------|
| src/components/io/__tests__/io.test.ts | ConstComponent > execute | executeConst preserves the pre-initialised output value | FAIL | Expected 48879 (0xBEEF), got 1 |
| src/components/io/__tests__/io.test.ts | ConstComponent > execute | executeConst with value 0 leaves output as 0 | FAIL | Expected 0, got 1 |
| src/components/io/__tests__/io.test.ts | GroundComponent > attributeMapping | Ground has no attribute mappings | FAIL | Expected array length 0, got 1 (has Bits mapping) |
| src/headless/__tests__/stress-test-regressions.test.ts | BUG-2: Splitter executeFn ignores port widths | executeSplitter should split 16-bit value into two 8-bit halves | FAIL | Expected 205 (0xCD), got 1 |
| src/fixtures/__tests__/fixture-audit.test.ts | Fixture Audit | Disconnected tunnel validation | FAIL | Multiple disconnected tunnels detected in fixtures |

## Notes

- All failures are pre-existing defects unrelated to the test capture
- The ConstComponent and GroundComponent issues appear to be related to IO component initialization/execution
- The Splitter regression is a known issue in stress-test-regressions
- The fixture audit tunnel disconnection appears to be a data integrity issue in fixture definitions
- Test execution was successful; failures are legitimate test assertions catching real bugs
