# Wave 4 — Test migrations

> Source: `docs/harness-redesign-spec.md` §6, §9.5, §10.2, §10.3, §12.5.
> Wave dependency: Wave 3 (comparison-session bulk + compare.ts + capture.ts landed).
> Sizing: sonnet (mechanical refactor, but spread across many test bodies).
> Runs in parallel with: Wave 5, Wave 6.
> Exit gate: `npm run test:q -- harness` — all harness tests pass except the known-BJT failures from `spec/test-baseline.md`.

## Tasks in this wave

| ID | Title | Files | Complexity |
|----|-------|-------|------------|
| W4.T1 | Delete `TestableComparisonSession` and `buildHwrSession`; migrate all callers to `createSelfCompare` | `src/solver/analog/__tests__/harness/query-methods.test.ts` | L |
| W4.T2 | Delete or rewrite test 30 (the `_comparisons` monkey-patch) — replace with fixture-based or compare.test.ts unit test | `src/solver/analog/__tests__/harness/query-methods.test.ts` (or new `compare.test.ts`) | M |
| W4.T3 | Sweep harness tests for `unaligned: true` assertions and `alignment` arguments — replace per §10.2 | `src/solver/analog/__tests__/harness/**/*.test.ts` | M |

---

## W4.T1 — Migrate to `createSelfCompare`

### Delete the back-door class at `:91-109`

```ts
// DELETE THIS ENTIRE CLASS
class TestableComparisonSession extends ComparisonSession {
  setTestSession(...) { /* monkey-patches _alignedNgIndex / _comparisons */ }
}
```

### Delete the helper at `:114-146`

```ts
// DELETE THIS ENTIRE FUNCTION
function buildHwrSession(...) {
  // builds an MNAEngine directly, runs dcOperatingPoint, manually wires hooks, ...
}
```

### Migrate every caller (tests numbered ~19-43 per §9.5)

Use Grep on `buildHwrSession` in `query-methods.test.ts` to find every call site. Each one looks like:

```ts
const session = buildHwrSession();
// ... assertions on session.getStepEnd(0), session.getDivergences(...), etc.
```

Replace with:

```ts
const session = await ComparisonSession.createSelfCompare({
  buildCircuit: () => makeHWR().circuit,
  analysis: "dcop",
});
// ... assertions unchanged ...
```

For tests that built a different fixture (e.g. `makeRC()` or a tran-path variant), use the matching factory and `analysis: "tran"` with a `tStop`. Look at the test's intent — the body of each test typically reveals which circuit and analysis it expects.

The test bodies that read `session.getStepEnd(0)`, `session.getDivergences(...)`, etc. work unchanged because the public API surface is preserved.

### `await` propagation

`createSelfCompare` is `async`. Each test that calls it must be `async` and `await` the call. Most vitest tests are already async; some may not be — convert them.

### Acceptance (W4.T1)

- `TestableComparisonSession` class is gone.
- `buildHwrSession` function is gone.
- Every caller of `buildHwrSession` now calls `await ComparisonSession.createSelfCompare({...})`.
- `npm run test:q -- query-methods` — tests pass except the known BJT failures.

---

## W4.T2 — Test 30 (the `_comparisons` monkey-patch)

Test 30 in `query-methods.test.ts` injects a fake `_comparisons` array via the `TestableComparisonSession.setTestSession` back door to drive a pagination test. With the back door deleted in W4.T1, this test no longer compiles.

Two acceptable replacements:

### Option A — Fixture-based

Build a small circuit that naturally produces the divergences the original test wanted (e.g. introduce a deliberate model parameter mismatch on one side, or use a circuit known to diverge between our engine and ngspice). The pagination assertions then run on real divergences.

### Option B — Move pagination test to `compare.test.ts`

If `src/solver/analog/__tests__/harness/compare.test.ts` exists (or create it), unit-test the divergence pagination logic directly with hand-built `CaptureSession` literals fed into `compareSnapshots`. This isolates the pagination logic from session lifecycle entirely.

Choose Option A if pagination must exercise the full session pipeline (preserves the integration coverage). Choose Option B if pagination is purely a function of `_getComparisons()` output and the session lifecycle adds no value.

### Acceptance (W4.T2)

- Test 30 is either deleted (if its coverage is now redundant) OR replaced with a fixture-based / compare.test.ts equivalent.
- The replacement test passes.

---

## W4.T3 — Sweep `unaligned` and `alignment` references

### Find all `unaligned` assertions

Use Grep on `unaligned` in `src/solver/analog/__tests__/harness/`. For each:

```ts
expect(report.unaligned).toBe(true);
// or
expect(report).toHaveProperty("unaligned");
```

Replace with:

```ts
expect(report.presence).toBe("oursOnly");   // or "ngspiceOnly", per the test's intent
```

If the test's intent is unclear (it just wanted "this step had no ngspice counterpart"), the replacement is `presence: "oursOnly"`. If the test wanted "ngspice had a step we didn't", it's `"ngspiceOnly"`.

### Find all `alignment` arguments to `compareSnapshots`

Use Grep on `compareSnapshots` in the harness directory. Any call with a fourth argument (`alignment`) must drop that argument:

```ts
// before
compareSnapshots(ours, ng, tol, someAlignment);
// after
compareSnapshots(ours, ng, tol);
```

### Acceptance (W4.T3)

- Zero `unaligned` references in `src/solver/analog/__tests__/harness/**/*.test.ts`.
- Zero four-argument `compareSnapshots` calls in `src/solver/analog/__tests__/harness/`.
- `npm run test:q -- harness` — all harness tests pass except known BJT failures (see `spec/test-baseline.md`).

---

## Wave 4 exit checklist

- [ ] `TestableComparisonSession` and `buildHwrSession` are deleted.
- [ ] All `buildHwrSession` callers migrated to `await ComparisonSession.createSelfCompare({...})`.
- [ ] Test 30 replaced or relocated.
- [ ] Zero `unaligned` references in harness test code.
- [ ] Zero `alignment` arguments to `compareSnapshots`.
- [ ] `npm run test:q -- harness` — passes (modulo known BJT baseline failures).
- [ ] `npm run test:q` — full sweep does not introduce new failures vs `spec/test-baseline.md`.

## Hard rules

- Read `CLAUDE.md` and `spec/test-baseline.md` before investigating any failure.
- Do NOT touch production code in this wave. If a test fails because of a Wave 3 bug (e.g. `getStepEnd` returning wrong shape), surface the problem in `spec/progress.md` for the verifier — do not patch the production code.
- Do NOT touch files outside `src/solver/analog/__tests__/harness/` and (optionally) a new `compare.test.ts`.
