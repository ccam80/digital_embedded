# Test Baseline

- **Timestamp**: 2026-04-08T00:00:00Z
- **Phase**: Phase 1 — Engine Accessor Changes
- **Command**: npm run test:q
- **Result**: 7967/7971 passing, 4 failing, 0 errors

## Failing Tests (pre-existing)

| Test | Status | Summary |
|------|--------|---------|
| src/solver/coordinator.ts::transient stepping does not error after 50 steps | FAIL | Analog engine stagnation: simTime stuck at 5.000004768371584e-9s |
| src/solver/coordinator.ts::survives 2000 transient steps without ERROR state | FAIL | Analog engine stagnation: simTime stuck at 5.000004768371584e-9s |
| src/solver/coordinator.ts::survives 600µs of sim time (matches UI run duration) | FAIL | Analog engine stagnation: simTime stuck at 5.000004768371584e-9s |
| src/solver/coordinator.ts::50 steps advance simTime > 0 without ERROR (regression: stale t=0 breakpoints must not freeze getClampedDt) | FAIL | Analog engine stagnation: simTime stuck at 5.000004768371584e-9s |

## Notes

All 4 failures are related to analog engine stagnation in the transient stepping tests within the coordinator. The same error message appears across all failures: "simTime stuck at 5.000004768371584e-9s. The engine exhausted all internal retries without advancing." These are pre-existing failures unrelated to the current baseline capture.
