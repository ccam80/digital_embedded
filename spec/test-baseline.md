# Test Baseline

- **Timestamp**: 2026-03-26T01:27:16Z
- **Phase**: Phase 5 (Simplify Consumers)
- **Command**: `npm test`
- **Result**: 7497/7501 passing, 4 failing, 0 errors

## Summary

Test Files: 328 passed, 2 failed (330 total)
Tests: 7497 passed, 4 failed (7501 total)
Duration: 29.66s (transform 39.44s, setup 0ms, collect 91.60s, tests 29.21s, environment 16.47s, prepare 105.28s)

## Failing Tests (pre-existing)

| Test | Status | Summary |
|------|--------|---------|
| src/io/__tests__/dig-parser.test.ts::DigParser::parsesRotation | FAIL | ENOENT: no such file or directory, open 'ref/Digital/src/main/dig/combinatorial/mux.dig' (missing submodule reference) |
| src/io/__tests__/dig-parser.test.ts::DigParser::resolvesXStreamReference | FAIL | ENOENT: no such file or directory, open 'ref/Digital/src/main/dig/combinatorial/mux.dig' (missing submodule reference) |
| src/io/__tests__/dig-parser.test.ts::DigParser::parsesInputCount | FAIL | ENOENT: no such file or directory, open 'ref/Digital/src/main/dig/combinatorial/mux.dig' (missing submodule reference) |
| src/io/__tests__/resolve-generics.test.ts::Generic::genAndExample | FAIL | ENOENT: no such file or directory, open 'ref/Digital/src/main/dig/generic/modify/genAnd.dig' (missing submodule reference) |

## Notes

All 4 failing tests are pre-existing and due to missing reference Digital submodule files (ENOENT errors). The tests attempt to read files from `ref/Digital/src/main/dig/` which are not present in the working directory. These are expected failures as noted in the task description ("Expected baseline is approximately 7496 passed / 4 failed (all pre-existing submodule ENOENT)").

No new test failures introduced.
