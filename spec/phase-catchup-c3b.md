# phase_catchup Wave C3b: Extended Test-Side Migration

## Overview

C3 (phase-catchup.md) officially migrated only 10 test files from deleted element APIs. `tsc --noEmit` reassessment surfaces **~40 additional test files** that drive elements through the deleted methods (`stamp()`, `stampNonlinear()`, `stampCompanion()`, `stampReactiveCompanion()`, `updateOperatingPoint()`, `updateState()`, `updateCompanion()`). 564 TypeScript errors remain across 50+ files; ~83% are TS2339 / TS2551 (property-does-not-exist / did-you-mean) pointing at these deleted methods in tests.

This wave finishes the C3 migration on every file that was out of C3's original 10-file scope, in 8 batches of 5 files each, plus one trivial production-side cleanup batch. Sibling to `phase-catchup.md`, not embedded in it. Completion is a hard prerequisite for starting Phase 4 alongside the rest of the catchup closeout.

## Governing Rules (read before any task)

1. **No rope.** Each implementer migrates exactly the files assigned to their task group. They do NOT chase TypeScript errors outside their file list. They do NOT touch production element code. They do NOT edit `test-helpers.ts`.
2. **Tests-red is expected.** The full suite will stay red until every C3b group completes. Implementers must not soften assertions or touch the logic of the tests they migrate — the goal is mechanical driver migration, not test rewriting.
3. **Mechanical rewrite only.** The migration is the same rewrite pattern C3 already established, applied uniformly:
   - `element.updateOperatingPoint!(voltages)` + `element.stampNonlinear!(solver)` → build a `LoadContext` via `makeSimpleCtx({ elements: [element], matrixSize, nodeCount })` and call `element.load(ctx)`.
   - `element.stampCompanion!(solver)` → same `element.load(ctx)` (reactive elements integrate inline inside `load()` now).
   - `element.stampReactiveCompanion!(...)` → same `element.load(ctx)`.
   - `element.updateState!(...)` → post-step work moves into `element.accept?.(ctx, simTime, addBreakpoint)` invocation paths; tests that previously called `updateState` after a step should call `accept` if the element implements it, or be deleted if they were probing state that's now internal.
   - `element.updateCompanion!(...)` → `element.accept?.(ctx, simTime, addBreakpoint)`.
   - `(el as any).stamp!(solver)` or any other `as any` + `!` bang-method invocation → direct `el.load(ctx)` with no cast and no bang.
   - `method-presence sniffs` (`if (el.isNonlinear && el.stampNonlinear)`) → unconditional `el.load(ctx)`.
   - `solver.stamp(row, col, value)` on an ad-hoc mock/ctx (ac-analysis.test.ts) → `const h = solver.allocElement(row, col); solver.stampElement(h, value);`.
4. **Assertion inspection.** Where a test reads values out of `(solver.stamp as ReturnType<typeof vi.fn>).mock.calls`, the implementer rewrites that read to interrogate the real `SparseSolver` after `load(ctx)` — e.g., `solver.getEntry(row, col)` — preserving the same comparison. If the test's mock surface is the only thing it asserts against, replace the mock with `new SparseSolver()` and inspect it.
5. **No assertion changes.** Every `.toBe(...)`, `.toBeCloseTo(...)`, `.toBeGreaterThan(...)` value and tolerance stays exactly as written. If the rewritten driver produces a different number than the old driver, that is a real divergence — surface it in the implementer's final report, do NOT relax the assertion.
6. **No "as any" or "!" survives.** Any `(element as any).methodName!(...)` pattern on a deleted-method name must be fully replaced with the migrated call — not left with a cast-to-any.
7. **Helper imports.** Import `makeSimpleCtx` (and `runDcOp` / `runNR` where the surrounding test logic calls the full solver) from `src/solver/analog/__tests__/test-helpers.js`. Do NOT add new helpers to `test-helpers.ts` — all required helpers already exist post-C3.1.
8. **Lock protocol.** Each implementer locks only the 5 files in its task group (test files only — production element files are read-only). No two C3b groups touch the same test file.
9. **No production edits.** The test migration groups (C3b.1 through C3b.8) MUST NOT modify any file outside their assigned test-file list. The production-side cleanup lives in C3b.prod and is the only group allowed to touch production files.

## Migration Pattern Reference

The canonical example is `src/solver/analog/__tests__/controlled-source-base.test.ts` (C3.2, already migrated). Before:

```ts
src.stampNonlinear!(solver);
```

After:

```ts
const ctx = makeSimpleCtx({ elements: [src], matrixSize: 1, nodeCount: 1 });
src.load(ctx);
```

When the test previously asserted via mock-call inspection:

```ts
const calls = (solver.stamp as ReturnType<typeof vi.fn>).mock.calls as number[][];
const diagEntry = calls.find((c) => c[0] === 1 && c[1] === 1);
const g = diagEntry![2];
```

rewrite to interrogate a real solver:

```ts
const solver = new SparseSolver();
const ctx = makeSimpleCtx({ solver, elements: [sw], matrixSize: N, nodeCount: N });
sw.load(ctx);
const g = solver.getEntry(0, 0);
```

For elements that need non-ground pins to be "up-shifted" by the compiler (so `pinNodeIds=[1,2]` maps into matrix rows `[0,1]`), use `makeSimpleCtx` directly — it builds the real `CKTCircuitContext` and the real `SparseSolver` behind it.

## Atomic Surrounding State

All 9 groups run in parallel. Each touches only its own files. The TypeScript error count during this wave is expected to start at ~564 and decrease monotonically as each group completes. The full suite will not be green mid-wave — tests-red is the accepted baseline until the last group finishes.

---

## Wave C3b File Inventory (39 files total)

### Group C3b.1 — Active components batch 1 (5 files)

- `src/components/active/__tests__/opamp.test.ts`
- `src/components/active/__tests__/comparator.test.ts`
- `src/components/active/__tests__/timer-555.test.ts`
- `src/components/active/__tests__/analog-switch.test.ts`
- `src/components/active/__tests__/real-opamp.test.ts`

**Acceptance**: `grep -E '\b(stampCompanion|updateOperatingPoint|stampNonlinear|stampReactiveCompanion|updateState|updateCompanion)\b' <files>` = 0 matches. No `as any` bang-method invocations survive. Files type-check as valid TypeScript against `AnalogElement`.

### Group C3b.2 — Active components batch 2 + passives batch 1 (5 files)

- `src/components/active/__tests__/adc.test.ts`
- `src/components/active/__tests__/schmitt-trigger.test.ts`
- `src/components/passives/__tests__/transformer.test.ts`
- `src/components/passives/__tests__/transmission-line.test.ts`
- `src/components/passives/__tests__/polarized-cap.test.ts`

**Acceptance**: same pattern as C3b.1.

### Group C3b.3 — Passives batch 2 (5 files)

- `src/components/passives/__tests__/tapped-transformer.test.ts`
- `src/components/passives/__tests__/inductor.test.ts`
- `src/components/passives/__tests__/capacitor.test.ts`
- `src/components/passives/__tests__/analog-fuse.test.ts`
- `src/components/passives/__tests__/crystal.test.ts`

**Acceptance**: same pattern as C3b.1.

### Group C3b.4 — Passives batch 3 + semiconductors batch 1 (5 files)

- `src/components/passives/__tests__/memristor.test.ts`
- `src/components/semiconductors/__tests__/diode.test.ts`
- `src/components/semiconductors/__tests__/zener.test.ts`
- `src/components/semiconductors/__tests__/tunnel-diode.test.ts`
- `src/components/semiconductors/__tests__/scr.test.ts`

**Acceptance**: same pattern as C3b.1.

### Group C3b.5 — Semiconductors batch 2 (5 files)

- `src/components/semiconductors/__tests__/mosfet.test.ts`
- `src/components/semiconductors/__tests__/jfet.test.ts`
- `src/components/semiconductors/__tests__/bjt.test.ts`
- `src/components/semiconductors/__tests__/triac.test.ts`
- `src/components/semiconductors/__tests__/diode-state-pool.test.ts`

**Acceptance**: same pattern as C3b.1.

### Group C3b.6 — Semiconductors batch 3 + sensors (5 files)

- `src/components/semiconductors/__tests__/triode.test.ts`
- `src/components/semiconductors/__tests__/diac.test.ts`
- `src/components/sensors/__tests__/ldr.test.ts`
- `src/components/sensors/__tests__/ntc-thermistor.test.ts`
- `src/components/sensors/__tests__/spark-gap.test.ts`

**Acceptance**: same pattern as C3b.1.

### Group C3b.7 — Solver-analog test batch 1 (4 files)

- `src/solver/analog/__tests__/dcop-init-jct.test.ts` *(partially migrated in C3.4 — finish any survivors)*
- `src/solver/analog/__tests__/behavioral-remaining.test.ts` *(partially migrated in C3.3 — finish any survivors)*
- `src/solver/analog/__tests__/behavioral-gate.test.ts`
- `src/solver/analog/__tests__/test-helpers.test.ts`

**Clarification (2026-04-18, user decision):** `src/solver/analog/__tests__/coupled-inductor.test.ts` is removed from C3b.7 scope. `CoupledInductorPair.stampCompanion` and `.updateState` on `src/solver/analog/coupled-inductor.ts` have zero production callers — `Transformer` / `TappedTransformer` inline the flux-linkage math in their own `load(ctx)`. Both methods are dead code. The user elected to delete the dead methods and the test file that exercised them; that work moves to C3b.prod.

**Acceptance**: same pattern as C3b.1. Do NOT edit `test-helpers.ts` (the production fixture file). Only edit `test-helpers.test.ts` (the test file that verifies `test-helpers.ts`). `test-helpers.test.ts` may retain banned names as string-literal indices inside negative `toBeUndefined()` assertions (`(mock as Record<string, unknown>)["stampNonlinear"]` etc.) — those assertions verify the factory does NOT expose the deleted methods and are intentionally preserved; the grep is a mechanical rewrite signal for driver call sites, and these negative assertions are explicitly exempt.

### Group C3b.8 — Solver-analog test batch 2 + ac + harness (4 files)

- `src/solver/analog/__tests__/digital-pin-model.test.ts`
- `src/solver/analog/__tests__/element-interface.test.ts`
- `src/solver/analog/__tests__/ac-analysis.test.ts` *(see Clarification below — file uses live 4-arg ComplexSparseSolver.stamp(row, col, re, im); NO migration work — grep acceptance narrowed)*
- `src/solver/analog/__tests__/harness/netlist-generator.test.ts`

**Clarification (2026-04-18, user decision):** The original bullet claiming `ac-analysis.test.ts` contains deleted `solver.stamp(row, col, value)` 3-arg calls is factually incorrect. All 11 `.stamp(` call sites in the file are the LIVE 4-arg `ComplexSparseSolver.stamp(row, col, re, im)` API on inline `makeAcResistor` / `makeAcCapacitor` / `makeAcInductor` elements inside `stampAc` bodies. `ComplexSparseSolver` does not expose `allocElement` / `stampElement`; the deleted method was the 3-arg real `SparseSolver.stamp` wrapper, which is tracked under Wave C5.1 and never existed on the complex solver. The file is kept in C3b.8 scope but requires NO `.stamp(` migration work — the acceptance grep is narrowed to exclude 4-arg `ComplexSparseSolver` calls.

**Acceptance**: same pattern as C3b.1. For `ac-analysis.test.ts`, `grep '\.stamp\s*\(' ` (excluding `stampElement`, `stampRHS`, `stampNonlinear`, `stampCompanion`, `stampAc`, AND 4-arg `ComplexSparseSolver.stamp(row, col, re, im)` calls) = 0 matches. The 11 4-arg complex stamps in `ac-analysis.test.ts` are explicitly exempt.

### Group C3b.prod — Production-side cleanup (4 files + 1 test deletion)

Small production-side backlog that surfaced in the same `tsc --noEmit` pass and is too small to merit its own wave.

- `src/solver/analog/coupled-inductor.ts` — two tasks on this file:
  1. **4× TS7030** "Function lacks ending return statement". Add `return` statements (or collapse conditional branches so every path returns) so the function signature is satisfied. No behaviour change — the missing returns are the result of a prior refactor that left unreachable branches uncovered.
  2. **Delete dead methods on `CoupledInductorPair`** (per 2026-04-18 user decision resolving the C3b.7 clarification): delete the `stampCompanion(...)` method (lines ~189-222) and the `updateState(...)` method (lines ~238-255) in their entirety. Both have zero production callers — `Transformer` and `TappedTransformer` inline the flux-linkage math in their own `load(ctx)`. The `CoupledInductorPair` class itself and its fields (`l1`, `l2`, `k`, `m`) and the `createState()` method remain — those are still read by `src/components/passives/transformer.ts` (lines 303-305, 458-468). If the internal helpers `historyCurrent1` / `historyCurrent2` / `mutualCoefficient` / `selfCoefficient` become unreferenced after the two method deletions, delete them too. If they're still referenced, leave them.
- `src/solver/analog/__tests__/coupled-inductor.test.ts` — **DELETE the entire file** (per the same user decision). The test was the sole caller of the two dead methods; deleting the methods without deleting the test would leave a dangling driver.
- `src/solver/analog/newton-raphson.ts:468-471` — dead comparisons. The block is wrapped in `if (curInitMode === "initFloat" || curInitMode === "transient")`; inside that block the ternary `curInitMode === "initJct" ? "dcopInitJct" : curInitMode === "initFix" ? "dcopInitFix" : "dcopInitFloat"` compares against values that cannot reach (TS-detected non-overlapping string literals). Simplify to `"dcopInitFloat"` — the only reachable arm.
- `src/solver/analog/dc-operating-point.ts:473-474` — 2× TS6133 unused variables. Delete the unused destructured names from the destructuring on the referenced line (keep only what's read in the function body).
- `src/solver/analog/element.ts:21` — TS6133 unused `SparseSolverStamp` import in the `import type { ... }` declaration. Remove `SparseSolverStamp` from that import-type list only; do NOT modify the re-export declaration (lines 13–19) — the re-export is public API and must stay.

**Acceptance**:
- `tsc --noEmit` for each of the four production files individually produces zero errors on the cited lines.
- `src/solver/analog/__tests__/coupled-inductor.test.ts` no longer exists on disk.
- `CoupledInductorPair.stampCompanion` and `CoupledInductorPair.updateState` no longer exist on the class; `transformer.ts` / `tapped-transformer.ts` still build (they don't call these methods).
- Grep for `\b(stampCompanion|updateState)\b` on `CoupledInductorPair` (the class body in `coupled-inductor.ts`) = 0 matches.
- No other production behaviour change — the remaining fixes are compile-only.
- Grep `SparseSolverStamp` in `src/solver/analog/element.ts` = 1 match only (the re-export, not the import).

**Do NOT** in C3b.prod:
- Touch any other test file (all test migration is owned by groups C3b.1–C3b.8). The `coupled-inductor.test.ts` deletion is the ONLY test-file change allowed in C3b.prod.
- Chase TypeScript errors outside the files named above.
- Rewrite function logic — every change is subtractive or minimal-fill (add `return`, remove unused name, collapse dead ternary arm, delete dead methods).
- Delete `CoupledInductorPair` itself or its fields / `createState()` — those are live production API consumed by `transformer.ts`.

---

## Closeout

C3b is complete when:

1. `grep -E '\b(stampCompanion|updateOperatingPoint|stampNonlinear|stampReactiveCompanion|updateState|updateCompanion)\b'` across all 39 test files = 0 matches.
2. `grep '\.stamp\s*\(' src/solver/analog/__tests__/ac-analysis.test.ts` (excluding `stampElement|stampRHS|stampNonlinear|stampCompanion|stampAc`) = 0 matches.
3. The four production files listed in C3b.prod type-check clean on the cited lines.
4. Total `tsc --noEmit` error count reassessed by the coordinator after all groups finish — expected to drop from 564 to a residual set that the coordinator adjudicates (full green may require follow-on work; that assessment is out of C3b scope).

After closeout, the coordinator reassesses TypeScript state and decides whether further waves are required to close out the catchup phase.
