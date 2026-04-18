# Wave C5 — Split into 5 Batches of 5 Files

This document supplements `phase-catchup.md` §C5 with an explicit file-by-file batch split. The original C5.1 task was intentionally "atomic" (exceeds 8-file limit); executing it as a single agent assignment stalled in practice. Implementers now work a bounded file list per batch, nothing more.

## What Wave C5 Actually Does

Delete `SparseSolver.stamp(row, col, value)` and migrate every **caller** to the handle-based API. The method itself has already been deleted from `src/solver/analog/sparse-solver.ts` (grep-verified: zero matches for `stamp\b` as a method definition). The residual `complexSolver.stamp(row, col, re, im)` calls in `src/solver/analog/ac-analysis.ts` are the **ComplexSparseSolver** sibling API — **OUT OF SCOPE** for C5 per `phase-catchup.md` line 67 (owned by Phase 0 Wave 0.4 Task 0.4.4).

All remaining `.stamp(` callers live in test files. These are the files each batch migrates.

## Non-Negotiable Rules For Every C5.x Implementer

1. **Only touch the files listed in your batch.** Do not open or edit any other file.
2. **No TypeScript chasing.** If your edit triggers a `tsc` error outside the migration pattern (bad cast, missing field, unrelated type drift), leave it. The coordinator will reassess `tsc` state after all 5 batches land.
3. **No test-chasing.** If a migrated test fails at runtime, record the failure in your final report and move on. Do NOT weaken the assertion, add `?.` guards, cast with `as any`, or delete the test.
4. **No drive-by refactors.** Do not rename variables, extract helpers, reorder imports, or "clean up" unrelated code.
5. **No new helpers unless strictly required.** If every call in a file can be rewritten inline with `allocElement`+`stampElement` or `load(ctx)`, do it inline.
6. **Do not run `tsc --noEmit`.** Do not run the full test suite. Run at most `npx vitest run <the_files_in_your_batch>` once at the end to record pass/fail counts.
7. **Do not invent a LoadContext shape.** Use `makeSimpleCtx` from `src/solver/analog/__tests__/test-helpers.ts` for any `ctx` you need. If the test setup can't reach `makeSimpleCtx`, construct a literal with the exact fields in `src/solver/analog/load-context.ts::LoadContext`.
8. **No scope broadening.** If you think the file needs more work than the mechanical pattern below (e.g. the test's mock solver lacks `allocElement`/`stampElement`, the test asserts on `.stamp` mock calls), do the minimum to silence that one site and keep going. Leave a `CLARIFICATION NEEDED` line in `spec/progress-catchup.md` if you hit an ambiguity you cannot resolve mechanically.

## Migration Patterns — Mechanical Rewrite Only

### Pattern A — direct `solver.stamp(row, col, value)`

Before:
```ts
solver.stamp(row, col, value);
```

After:
```ts
const h = solver.allocElement(row, col);
solver.stampElement(h, value);
```

Prefer hoisting the `allocElement` call out of hot loops when obvious; if not obvious, leave inline.

### Pattern B — `element.stamp(solver)` on a component instance

Before:
```ts
const solver = makeMockSolver();
element.stamp(solver);
```

After (simplest form — real solver):
```ts
import { makeSimpleCtx } from "../../../solver/analog/__tests__/test-helpers.js";
// …
const ctx = makeSimpleCtx({ elements: [element], matrixSize, nodeCount });
element.load(ctx);
```

If the test body reads mock call history (`mock.calls`) from a `vi.fn()` solver, replace the mock solver with a **capture solver** that exposes `allocElement(row, col)` returning a handle and `stampElement(handle, value)` recording `(row, col, value)` into an array. Pattern C4.5 used this — search `src/components/active/__tests__/opamp.test.ts` for a working example after it lands.

### Pattern C — inline element literal with `stamp:` field

Before:
```ts
const rLoad: AnalogElement = {
  pinNodeIds: [...], allNodeIds: [...], branchIndex: -1,
  isNonlinear: false, isReactive: false,
  setParam(...) {}, getPinCurrents(...) { return []; },
  stamp(solver) {
    solver.stamp(row, col, value);
  },
};
```

After:
```ts
const rLoad: AnalogElement = {
  pinNodeIds: [...], allNodeIds: [...], branchIndex: -1,
  isNonlinear: false, isReactive: false,
  setParam(...) {}, getPinCurrents(...) { return []; },
  load(ctx) {
    const h = ctx.solver.allocElement(row, col);
    ctx.solver.stampElement(h, value);
  },
};
```

(If you're tempted to just use `makeResistor` from `test-helpers.ts` — do it; it returns an `AnalogElement` with `load(ctx)` built in. But do NOT refactor existing inline element definitions unless the migration forces it.)

### Pattern D — mock solver `{ stamp: vi.fn(), stampRHS: vi.fn() }`

If the test asserts on `(solver.stamp as Mock).mock.calls`, replace with a capture object:
```ts
const stamps: [number, number, number][] = [];
const rhs: [number, number][] = [];
const solver = {
  allocElement: vi.fn((row: number, col: number) => {
    stamps.push([row, col, 0]);
    return stamps.length - 1;
  }),
  stampElement: vi.fn((h: number, v: number) => {
    stamps[h][2] += v;
  }),
  stampRHS: vi.fn((row: number, v: number) => {
    rhs.push([row, v]);
  }),
} as unknown as SparseSolver;
```

Then update assertions to read from `stamps` instead of `solver.stamp.mock.calls`.

If the assertions become too tangled to rewrite mechanically, STOP and surface it as `CLARIFICATION NEEDED` in `spec/progress-catchup.md`. Do NOT delete assertions.

## Batches

### Batch C5.a — simple passives (5 files)

- `src/components/passives/__tests__/resistor.test.ts`
- `src/components/passives/__tests__/potentiometer.test.ts`
- `src/components/passives/__tests__/capacitor.test.ts`
- `src/components/passives/__tests__/inductor.test.ts`
- `src/components/passives/__tests__/polarized-cap.test.ts`

### Batch C5.b — transformers + probe + ground (5 files)

- `src/components/passives/__tests__/transformer.test.ts`
- `src/components/passives/__tests__/tapped-transformer.test.ts`
- `src/components/passives/__tests__/transmission-line.test.ts`
- `src/components/io/__tests__/probe.test.ts`
- `src/components/sources/__tests__/ground.test.ts`

### Batch C5.c — sources + clock + switches (5 files)

- `src/components/sources/__tests__/dc-voltage-source.test.ts`
- `src/components/sources/__tests__/ac-voltage-source.test.ts`
- `src/components/sources/__tests__/current-source.test.ts`
- `src/components/io/__tests__/analog-clock.test.ts`
- `src/components/switching/__tests__/switches.test.ts`

### Batch C5.d — active components (5 files)

- `src/components/active/__tests__/opamp.test.ts`
- `src/components/active/__tests__/real-opamp.test.ts`
- `src/components/active/__tests__/comparator.test.ts`
- `src/components/active/__tests__/analog-switch.test.ts`
- `src/components/active/__tests__/timer-555.test.ts`

### Batch C5.e — semiconductor + bridges (5 files)

- `src/components/semiconductors/__tests__/diode.test.ts`
- `src/solver/analog/__tests__/bridge-adapter.test.ts`
- `src/solver/analog/__tests__/bridge-compilation.test.ts`
- `src/solver/__tests__/coordinator-bridge.test.ts`
- `src/solver/__tests__/coordinator-bridge-hotload.test.ts`

## Acceptance (Per Batch)

For every file in your batch:

1. Grep `\.stamp\s*\(` excluding `stampElement|stampRHS|stampAc|stampNonlinear|stampCompanion|stampOutput|stampReactiveCompanion` → **0 matches**.
2. Grep the broad pattern `stamp\s*\(` including declarations — the only remaining matches must be method signatures on **other** types (`SparseSolverStamp`, `ComplexSparseSolver.stamp`) or comments/doc that happen to contain the word.
3. Your final report in `spec/progress-catchup.md` lists each file, the pattern counts before/after, and any tests that turned red (with the measured numbers — do not describe, quote).

## What Comes After All Five Batches

The coordinator will re-run `npx tsc --noEmit` on the whole tree and inspect the result. If non-trivial TS errors remain inside your 25 files, a cleanup batch will be scoped. **Nothing about that cleanup is in your scope today.**
