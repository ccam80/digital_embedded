# Test Baseline

- **Timestamp**: 2026-04-19T00:00:00Z (coordinator-authored)
- **Phase**: Pre-parallel-waves (Phase 0.4 + Phase 4 + Phase 5 + Phase 7.1 about to start in one parallel batch)
- **Command**: n/a — full suite **hangs indefinitely** in this job.
- **Result**: **RED across the suite.** Tests are expected to remain red until late Phase 7.

## Critical facts for implementers and verifiers

**The full test suite is red and will stay red until late Phase 7.** This is the intended mid-refactor state per `spec/plan.md` "Inter-Phase Breakage Carve-Out". Do NOT treat red as failure caused by your changes unless you can positively show a regression in tests **you** explicitly touched.

## CRITICAL TEST INVOCATION RULE (for ALL implementers AND verifiers)

**NEVER run `npm test`, `npm run test:q`, or any full-suite invocation.** The suite hangs indefinitely and will stall the whole job.

- ❌ `npm test`
- ❌ `npm run test:q`
- ❌ `npx vitest run` (with no path argument — targets everything)
- ✅ `npx vitest run <specific file path>` — e.g. `npx vitest run src/solver/analog/__tests__/dc-operating-point.test.ts`
- ✅ `npx vitest run <specific directory>` — e.g. `npx vitest run src/solver/analog/__tests__/`  *(only a small targeted subfolder — never the whole project)*

Always target the specific file(s) you just edited. Add `--reporter=default --no-coverage` if output is too verbose.

If a targeted file appears to hang (>60s), kill it — the hang probably comes from cross-file module-load breakage from an in-flight sibling phase. Report that fact and move on; do not try to diagnose the other phase's breakage.

## Guidance for Phase 4 / Phase 5 / Phase 0.4 / Phase 7.1 implementers

- Run ONLY the tests you added or the tests for the file(s) you edited.
- If a test you did NOT touch fails, it is pre-existing red and NOT your concern.
- Do not soften, skip, or relax any `.toBe(...)` / `.toBeCloseTo(...)` assertion values or tolerances to make other reds go green — surface divergence rather than hiding it.
- A spec-exact numerical test that detects real ngspice divergence is a **signal**, not a bug — surface it, don't rewrite it.

## Known-red regions (pre-existing, not caused by current batch)

Do not investigate failures in the following regions unless they are in files you explicitly modified:

- `src/editor/__tests__/wire-current-resolver.test.ts` — 2 pre-existing KCL/assertion failures
- `src/headless/__tests__/rlc-lte-path.test.ts` — multiple engine-stagnation / large-value-ratio failures
- `src/io/dts-schema.ts` schema validation failures
- All mid-phase cross-boundary `tsc --noEmit` errors per the "Inter-Phase Breakage Carve-Out" in `spec/plan.md`.

Any test specifically named in Phase 4 / Phase 5 / Phase 0.4 / Phase 7.1 task bodies is YOUR responsibility to deliver green (or surface as red-detecting-real-ngspice-divergence with full diff). All other reds are not your concern.
