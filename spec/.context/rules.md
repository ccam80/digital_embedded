# Non-Negotiable Implementation Rules

These rules are absolute. No agent may override, soften, or interpret them flexibly.

## Testing
- Tests ALWAYS assert desired behaviour. Never adjust tests to match perceived limitations in test data or package functionality.
- Failing tests are the best signal. We want them. They indicate thorough testing.
- No `pytest.skip()`, `pytest.xfail()`, `unittest.skip`, or soft assertions. Ever.
- No `pytest.approx()` with loose tolerances to make tests pass.
- Test the specific: exact values, exact types, exact error messages where applicable.

### Targeted Tests Only — NEVER the Full Suite

Engine-internal phases (0 through 6) must be verified with **targeted vitest runs only**. Agents MUST NOT run:

- `npm test` / `npm run test` / `npm run test:q` — runs the full suite including Playwright E2E.
- `npx playwright test` or anything under `e2e/` — E2E tests may regress during engine refactors and won't recover until Phase 7 lands.
- `npx vitest run` with no path argument — runs all vitest files across the repo.

Instead, run **only the specific test file(s) you touched**:

```bash
npx vitest run src/solver/analog/__tests__/sparse-solver.test.ts
npx vitest run src/solver/analog/__tests__/newton-raphson.test.ts src/solver/analog/__tests__/ckt-context.test.ts
```

Rationale: full-suite runs during Phases 0–6 hit E2E tests that are known to break during the refactor (numerical divergence, engine stagnation). They lock up the machine for ~5 minutes and produce noise that masks real regressions. Phase 7 is the single gate where full-suite / parity tests run. Pre-existing failures are already documented in `spec/test-baseline.md`.

If you think you need broader coverage, first spawn a new implementer for the next task and let the phase boundary's wave-verifier batch-check. Do not second-guess this rule — it is here because a prior agent DID lock up the user's machine.

## Completeness
- Never mark work as deferred, TODO, or "not implemented."
- Never add `# TODO`, `# FIXME`, `# HACK` comments.
- Never write `pass` or `raise NotImplementedError` in production code.
- Proceed linearly through the task. Complex items are handled as they arise.
- If you cannot finish: write detailed progress to spec/progress.md so the next agent can continue from exactly where you stopped. Do not summarize — be specific about what's done and what's next.

## Code Hygiene
- No fallbacks. No backwards compatibility shims. No safety wrappers.
- All replaced or edited code is removed entirely. Scorched earth.
- No commented-out code. No `# previously this was...` comments.
- **Historical-provenance comments are dead-code markers.** Any comment containing words like "legacy", "fallback", "backwards compatible", "previously", "migrated from", "replaced", "shim", "workaround", "temporary", or "for now" is almost never just a comment problem. The comment exists because an agent left dead or transitional code in place and wrote a comment to avoid deleting it — which would have required fixing tests or completing the real implementation. When you find such a comment: (1) treat the **code it decorates** as dead/broken, (2) delete both the code and the comment, (3) fix or rewrite any tests that depended on the dead code path. Removing only the comment while leaving the code is a rule violation.
- Comments exist ONLY to explain complicated code to future developers. They never describe what was changed, what was removed, or historical behaviour.
- No feature flags, no environment-variable toggles for old/new behaviour.

## Shell Compatibility (Windows)

This project runs on Windows with Git Bash. All bash commands MUST be Windows-safe:

- **Always double-quote paths.** Backslashes are interpreted as escape characters in unquoted strings. Every path in every command must be wrapped in double quotes: `mkdir -p "spec/.locks/tasks"`, not `mkdir -p spec/.locks/tasks`.
- **Use forward slashes in paths.** Write `"spec/.locks/files/src__main.py"`, not `"spec\.locks\files\src__main.py"`. Git Bash handles forward slashes natively. Backslashes require quoting and are fragile.
- **Never use `NUL`** — use `/dev/null`.
- **Never use Windows-native commands** (`dir`, `del`, `copy`, `type`, `findstr`). Use their Unix equivalents (`ls`, `rm`, `cp`, `cat`, `grep`).
- **Quote variable expansions.** Write `"${TASK_ID}"` not `${TASK_ID}` when the value could contain spaces or special characters.
- **Use `bash` explicitly when invoking scripts.** Write `bash "path/to/script.sh"`, not `./path/to/script.sh` or `sh "path/to/script.sh"`.

## Git Safety
- Never use `git stash`. Test baselines are provided in `spec/test-baseline.md`.
- Never use `git checkout` to discard or switch changes.
- Never use `git reset` to undo changes.
- Never use `git clean` to remove untracked files.
- If you need to understand pre-existing test state, read `spec/test-baseline.md`.

## Agent Discipline
- Never soften, reinterpret, or "pragmatically adjust" these rules.
- If a rule seems to conflict with the task, flag it to the orchestrator. Do not resolve the conflict yourself.
