# Test Baseline

- **Timestamp**: 2026-03-25T21:19:14Z
- **Phase**: Phase 6 (Directory restructure — engine/ and analog/ → solver/)
- **Command**: npm test
- **Result**: 7517/7521 passing, 4 failing, 0 errors

## Summary

Test Files: 329 passed, 2 failed (331 total)
Tests: 7517 passed, 4 failed (7521 total)
Duration: 14.12s (transform 18.23s, setup 0ms, collect 63.17s, tests 23.76s, environment 6.25s, prepare 49.16s)

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
