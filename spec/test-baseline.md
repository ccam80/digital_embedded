# Test Baseline — INTENTIONALLY ABSENT

**This run does not produce a test baseline.** The automated baseline-capture agent hangs indefinitely on this project (long-running vitest + harness tests exceed agent runtime budgets). Rather than produce a partial / stale baseline, this run operates under an **expected-red** policy.

## Policy (authoritative — see `spec/plan.md` Appendix A "Test discipline")

- **Tests are expected red.** The engine is not expected to be ngspice-exact until Phase 10 closes. Many tests across the suite will fail for reasons unrelated to the current task.
- **No test-chasing.** Do NOT modify tests you did not write. Do NOT weaken assertions. Do NOT skip / xfail / widen tolerances to "make tests pass."
- **Targeted vitest only, 120s timeout.** `npx vitest run --testTimeout=120000 <specific-path>`. Full-suite `npm test` is forbidden until Phase 9 Task 9.1.3.
- **Pre-existing vs. regression.** You cannot determine this from a baseline this run. Report failures and timeouts verbatim in your completion report — the user distinguishes pre-existing from regression at review time.

## What to do when a test fails

1. Run only the targeted vitest invocation listed in your task's "Tests" section.
2. If the targeted tests named in your task's **Acceptance criteria** pass: your work is done. Other failures in unrelated files are NOT your concern.
3. If a targeted test named in your acceptance criteria fails:
   - Check whether the failure is caused by your edit (read the failing test, trace back).
   - If caused by your edit: fix the edit (not the test).
   - If the failure pre-dates your edit: report it verbatim and move on. Do not chase.
4. If vitest times out (120s wall clock): report the timeout verbatim — test name, full command, tail of output. Do NOT retry with `--testTimeout=240000`. Do NOT split the test.

## Completion-report expectations

Your completion report MUST include:

- Every test file you ran (full `npx vitest run` command line).
- Every failure: test name, first 20 lines of stack.
- Every timeout: test name, how many seconds elapsed before the 120s deadline fired.
- The vitest exit code.

Agents that omit this information are considered to have returned dishonestly.

## Why no baseline

The previous Phase-2.5 execution produced test baselines for specific sub-runs. That approach required a healthy full-suite run to complete in a bounded time — this run's test matrix (including the ngspice harness parity tests under `src/solver/analog/__tests__/ngspice-parity/`) is larger and the harness tests are flaky-with-timeouts when run outside their intended Phase-10 lane. Producing a baseline would either take longer than the plan allows or produce misleading data. **Operating without a baseline under strict expected-red discipline is the correct choice for this run.**
