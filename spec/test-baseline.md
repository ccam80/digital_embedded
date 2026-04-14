# Test Baseline
- **Timestamp**: 2026-04-14T00:00:00Z
- **Phase**: ngspice-alignment
- **Command**: npm run test:q
- **Result**: 8292/8294 passing, 2 failing, 0 skipped (18.3s, 364 files)

## Failing Tests (pre-existing)
| Test | File | Status | Summary |
|------|------|--------|---------|
| rc_lowpass | src/components/sources/__tests__/ac-voltage-source.test.ts:307 | FAIL | Frequency response magnitude at expected frequency exceeds tolerance (expected 1.516 < 0.864) |
| rl_dc_steady_state_tight_tolerance | src/solver/analog/__tests__/mna-end-to-end.test.ts:379 | FAIL | DC steady-state tolerance failure (expected 0.690 < 0.1) |

## Notes
- Tests ran successfully with standard infrastructure
- 2 pre-existing failures related to analog circuit numerical tolerances
- Both failures appear to be convergence/tolerance issues in the ngspice-alignment phase
- Failure details stored in `.vitest-failures.json`
