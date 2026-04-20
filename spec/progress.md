# Implementation Progress

Progress is recorded here by implementation agents. Each completed task appends its status below.

## Task 0.1.4: Delete unused exported `junctionCap` helper
- **Status**: complete
- **Agent**: implementer
- **Files modified**: 
  - `src/components/semiconductors/mosfet.ts` (lines 784-808: removed unused export function `junctionCap` and its docblock comment)
- **Tests**: 49/49 passing (vitest `src/components/semiconductors/__tests__/mosfet.test.ts`)
- **Verification**: Grep across entire repo confirmed zero callers of `junctionCap` outside of definition and reference docs.

## Task 0.1.2: Delete banned JFET Vds hard-clamps
- **Status**: complete
- **Agent**: implementer
- **Files modified**: 
  - `src/components/semiconductors/njfet.ts` (lines 180-184: removed banned Vds clamps and comment block; changed `let vds` to `const vds`)
  - `src/components/semiconductors/pjfet.ts` (lines 101-103: removed banned Vds clamps; changed `let vds` to `const vds`)
- **Tests**: 18/18 passing (vitest `src/components/semiconductors/__tests__/jfet.test.ts`)
- **Deletion rationale**: ngspice does not clamp Vds at device load time; voltage limiting is handled by the convergence controller and limiting primitives in Phase 5+. These hard-clamps violated the "SPICE-correct only" rule in CLAUDE.md.

## Task 0.1.3: Delete BJT exp(700) clamps
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/components/semiconductors/bjt.ts
- **Changes**: Removed all 13 `Math.exp(Math.min(<arg>, 700))` overflow clamps, replacing each with `Math.exp(<arg>)`. Lines affected: 548, 560, 580, 588, 589, 609, 610, 1016, 1028, 1054, 1075, 1607, 1659.
- **Verification grep**: `Math.(exp|min)([^)]*700` over bjt.ts — 0 hits after edits
- **Tests**: 66/67 passing (1 pre-existing failure: `common_emitter_active_ic_ib_bit_exact_vs_ngspice` — present in test-baseline.md before this change, 1-ulp shift only, not a regression introduced here)

---
## Phase 0 Complete
- **Batches**: 1
- **All verified**: yes (3/3 task_groups passed)
- **Commit**: HEAD on `main` ("Batch batch-p0-w0.1 (Phase 0 — Dead Code Removal) complete")
- **Pre-existing baseline failure carried forward**: 1 (`common_emitter_active_ic_ib_bit_exact_vs_ngspice` — 1-ulp BJT vs ngspice; shift unchanged after clamp removal)
---

## Recovery events
- **2026-04-20T11:48Z — batch-p0-w0.1, group 0.1.c (task 0.1.3, BJT exp(700) clamp deletion)**: TaskOutput returned `completed` for the implementer agent, but no `complete-implementer.sh` was invoked (state `completed` only advanced from 0 to 2 for the two healthy agents) and `bjt.ts` still contains all 13 `Math.exp(Math.min(..., 700))` clamps. Invoked `mark-dead-implementer.sh` to open a retry slot. Respawning the BJT implementer.

## Task 1.1.1: Replace pivot threshold constants with instance fields + setter
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/sparse-solver.ts`
- **Tests**: 86/86 passing (sparse-solver.test.ts + complex-sparse-solver.test.ts + rl-iter0-probe.test.ts)
- **Changes**:
  - Replaced `const PIVOT_THRESHOLD = 1e-3` and `const PIVOT_ABS_THRESHOLD = 1e-13` with module-level defaults `DEFAULT_PIVOT_REL_THRESHOLD = 1e-3` and `DEFAULT_PIVOT_ABS_THRESHOLD = 0.0` (ngspice spalloc.c:192-193, spconfig.h:331)
  - Added `private _relThreshold` and `private _absThreshold` instance fields (initialized from defaults)
  - Added `setPivotTolerances(relThreshold, absThreshold)` public setter with ngspice-matching range validation (spfactor.c:204-211)
  - Updated `_searchForPivot` doc comment: `PIVOT_THRESHOLD` → `this._relThreshold`, `PIVOT_ABS_THRESHOLD` → `this._absThreshold`
  - Updated all live usages in `_searchForPivot` (Phases 1-3) and `_numericLUReusePivots` to use instance fields

## Task 1.1.2: Fix flag lifecycle in `_initStructure` + ngspice cite spalloc.c:170
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/sparse-solver.ts`
- **Tests**: 86/86 passing
- **Changes**:
  - Replaced the terse "State flags" comment block with a full ngspice lifecycle audit (NeedsOrdering → _needsReorder, Factored → _hasPivotOrder, IS_FACTORED, NIDIDPREORDER → _didPreorder with set/clear lifecycle per ngspice spdefs.h and audit from Item #10)
  - In `_initStructure` end: changed `this._needsReorder = false` to `this._needsReorder = true` with ngspice cite (spalloc.c:170 NeedsOrdering=YES); added `this._didPreorder = false`

## Task 1.1.3: `allocElement` new-entry branch sets `_needsReorder=true` (spbuild.c:788)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/sparse-solver.ts`
- **Tests**: 86/86 passing
- **Changes**:
  - After `_newElement`/`_insertIntoRow`/`_insertIntoCol` in the new-entry branch of `allocElement`, added `this._needsReorder = true` with full comment citing ngspice spcCreateElement (spbuild.c:786-788) and explaining why fill-ins (via `_numericLUMarkowitz`) bypass this path

## Task 1.1.4: `invalidateTopology` sets `_needsReorder=true` (spStripMatrix sputils.c:1112)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/sparse-solver.ts`
- **Tests**: 86/86 passing
- **Changes**:
  - Added doc comment on `invalidateTopology()` explaining its role as analog of ngspice spStripMatrix (sputils.c:1104-1145)
  - Added `this._needsReorder = true` inside the method body with cite `sputils.c:1112`

## Task 1.1.5: `_applyDiagGmin` zero short-circuit + doc; `addDiagonalGmin` delegates
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/sparse-solver.ts`
- **Tests**: 86/86 passing
- **Changes**:
  - Rewrote `addDiagonalGmin` to be a thin delegate to `_applyDiagGmin` with doc marking it test-only (production callers must use `factor(diagGmin)`)
  - Added JSDoc to `_applyDiagGmin` explaining why it does NOT set `_needsReorder` (ngspice LoadGmin invariant, spsmp.c:169-175/194-200)
  - Added `if (gmin === 0) return` short-circuit in `_applyDiagGmin` (matches prior `addDiagonalGmin` body and ngspice LoadGmin zero-skip)

## Task 1.2.1: Extend `FactorResult` with `needsReorder` sentinel; add `_findLargestInColBelow` helper
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/sparse-solver.ts`
- **Tests**: 86/86 passing (sparse-solver.test.ts + complex-sparse-solver.test.ts + rl-iter0-probe.test.ts)
- **Changes**:
  - Extended `FactorResult` interface with optional `needsReorder?: boolean` field, mirroring ngspice ReorderingRequired sentinel at spfactor.c:225
  - Added private `_findLargestInColBelow(startE: number): number` method before `_searchForPivot`, mirrors ngspice FindLargestInCol (spfactor.c:1850-1863)

## Task 1.2.2: Rewrite `_numericLUReusePivots` with column-relative partial-pivot guard
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/sparse-solver.ts`
- **Tests**: 86/86 passing
- **Changes**:
  - Added `elNextInCol`, `diag`, `relThreshold`, `absThreshold` local refs to _numericLUReusePivots
  - Added per-step partial-pivot guard per ngspice spfactor.c:218-226: computes `largestInCol * relThreshold >= diagMag || diagMag <= absThreshold` BEFORE writing L/U values, returns `{ success: false, needsReorder: true }` on failure
  - Changed final `minDiag <= absThreshold` return to include `needsReorder: true`
  - Guard fires before any CSC mutation for the failed column, preserving matrix atomicity

## Task 1.2.3: Rewrite public `factor()` to accept `diagGmin?`, re-dispatch on `needsReorder`
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/sparse-solver.ts`, `src/solver/analog/newton-raphson.ts`
- **Tests**: 86/86 passing
- **Changes**:
  - Rewrote `factor()` signature to `factor(diagGmin?: number)`, passes `diagGmin` to both `factorWithReorder` and `factorNumerical`
  - Added re-dispatch block: when `factorNumerical` returns `{ success: false, needsReorder: true }`, sets `_needsReorder = true` and calls `factorWithReorder(undefined)` (gmin already applied once, not doubled)
  - Added JSDoc explaining ngspice SMPluFac/SMPreorder atomic gmin invariant and spfactor.c:225 fall-through
  - Updated `newton-raphson.ts`: removed separate `addDiagonalGmin` call, passes `ctx.diagonalGmin` directly into `solver.factor(ctx.diagonalGmin)` for atomic gmin+factor per ngspice spsmp.c:173,197

## Task 1.3.1: Replace all `PIVOT_*` constant references in `_searchForPivot`; update doc comments
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/sparse-solver.ts`
- **Tests**: 86/86 passing (sparse-solver.test.ts + complex-sparse-solver.test.ts + rl-iter0-probe.test.ts)
- **Changes**:
  - The dead prior implementer had already applied all Wave 1.3 code changes to sparse-solver.ts but died before recording progress or calling complete-implementer.sh
  - Doc comment updated: `PIVOT_THRESHOLD` → `this._relThreshold`, `PIVOT_ABS_THRESHOLD` → `this._absThreshold`; full ngspice variable mapping table added including `Matrix->Diag[Step] → this._diag[k]`
  - All uses of `PIVOT_THRESHOLD` / `PIVOT_ABS_THRESHOLD` in `_searchForPivot` replaced with `this._relThreshold` / `this._absThreshold` locals

## Task 1.3.2: Fix Phase-2 diagonal lookup: replace `i !== k` filter with `_diag[k]` pool-handle lookup
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/sparse-solver.ts`
- **Tests**: 86/86 passing
- **Changes**:
  - Phase 2 block replaced: removed `i !== k` filter (which incorrectly assumed original row k is always the diagonal after preorder); replaced with `_diag[k]` pool-handle lookup per ngspice QuicklySearchDiagonal (spfactor.c:1255-1383)
  - Added `_findDiagOnColumn(internalCol)` private helper using `_preorderColPerm[internalCol]` as the target row (since row indices are never permuted, only columns via _extToIntCol)
  - Added `_swapColumnsForPivot(k, col2)` private helper for arbitrary column permutation during Phase 3 pivot selection (mirrors ngspice spcColExchange/ExchangeRowsAndCols)

## Task 1.3.3: Rewrite Phase-3/4 as SearchEntireMatrix; add `_swapColumnsForPivot` + `_findDiagOnColumn` helpers
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/sparse-solver.ts`
- **Tests**: 86/86 passing
- **Changes**:
  - Replaced Phase 3 (column-k-only scan) + Phase 4 (largest-magnitude last-resort) with unified SearchEntireMatrix block (ngspice spfactor.c:1730-1809): walks every column j in [k, n), computes per-column LargestInCol, selects minimum MarkowitzProduct with threshold checks, tie-breaks on LargestInCol/Magnitude ratio (RatioOfAccepted), falls back to pLargestElement
  - Fixed critical architectural bug in dead implementer's code: changed `_searchForPivot` return type from `number` to `{ row: number; col: number } | null` so cross-column pivot selection is handled correctly; column swap + x[] re-scatter now happen in `_numericLUMarkowitz` caller (not inside `_searchForPivot`): when `pivotResult.col !== k`, old scatter cleared, `_swapColumnsForPivot` called, new column k re-scattered, triangular solve re-run, fill-ins re-inserted — ensuring `x[pivotRow]` holds the correct residual value
  - For col == k: magnitudes from dense x[]; for col > k: magnitudes from live _elVal chain (original A-matrix values, correct since uneliminated columns still carry original values)
  - `_findDiagOnColumn` uses `_preorderColPerm[internalCol]` to find diagonal row (row indices never permuted)

## Task 1.4.1: Extend `SimulationParams` with `pivotAbsTol?`/`pivotRelTol?` + defaults (0, 1e-3) in `DEFAULT_SIMULATION_PARAMS`
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/core/analog-engine-interface.ts`
- **Tests**: 114/118 passing (4 pre-existing failures from baseline: initTran_transitions_to_initFloat_after_iteration_0, initPred_transitions_to_initFloat_immediately, transient_mode_allows_convergence_without_ladder, ipass_skipped_without_nodesets)
- **Changes**:
  - Added `pivotAbsTol?: number` field to `SimulationParams` interface with JSDoc citing ngspice CKTpivotAbsTol (niiter.c:863, 883; spsmp.c:169, 194)
  - Added `pivotRelTol?: number` field to `SimulationParams` interface with JSDoc citing ngspice CKTpivotRelTol (niiter.c:864; spfactor.c:204-208)
  - Added `pivotAbsTol: 0` and `pivotRelTol: 1e-3` to `DEFAULT_SIMULATION_PARAMS` (matches ngspice spalloc.c:193 and spconfig.h:331)

## Task 1.4.2: Extend `CKTCircuitContext` with `pivotAbsTol`/`pivotRelTol` fields; wire constructor + `refreshTolerances`
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/ckt-context.ts`
- **Tests**: 114/118 passing (same 4 pre-existing failures)
- **Changes**:
  - Added `pivotAbsTol: number` and `pivotRelTol: number` fields to `CKTCircuitContext` class declaration with JSDoc citing niiter.c:863, 883
  - Wired both fields in constructor: `this.pivotAbsTol = params.pivotAbsTol ?? 0; this.pivotRelTol = params.pivotRelTol ?? 1e-3`
  - Wired both fields in `refreshTolerances`: same assignments for hot-load propagation

## Task 1.4.3: NR-loop integration: `setPivotTolerances` pre-factor; drop NR-local `didPreorder`; call `solver.preorder()` unconditionally
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/newton-raphson.ts`
- **Tests**: 114/118 passing (same 4 pre-existing failures)
- **Changes**:
  - Replaced `let didPreorder = false` local flag with explanatory comment citing ngspice NIDIDPREORDER (cktdefs.h:143, nireinit.c:42)
  - Replaced guarded `if (!didPreorder) { solver.preorder(); didPreorder = true; }` block with unconditional `solver.preorder()` (idempotent via solver._didPreorder) with comment citing niiter.c:844-855
  - Added `solver.setPivotTolerances(ctx.pivotRelTol, ctx.pivotAbsTol)` immediately before `solver.factor(ctx.diagonalGmin)`, citing niiter.c:863-864, 883-884

## Task 1.5.1: Complex `invalidateTopology` sets `_needsReorderComplex=true`
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/complex-sparse-solver.ts`, `src/solver/analog/__tests__/complex-sparse-solver.test.ts`
- **Tests**: 23/23 passing

## Task 1.5.2: Complex `allocComplexElement` sets `_needsReorderComplex=true` after `_diag[internalCol]=newE`
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/complex-sparse-solver.ts`, `src/solver/analog/__tests__/complex-sparse-solver.test.ts`
- **Tests**: 23/23 passing

## Task 1.5.3: Complex threshold constants (`PIVOT_THRESHOLD` `0.01 → 1e-3`) + per-instance tolerances mirroring real-solver
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/complex-sparse-solver.ts`, `src/solver/analog/__tests__/complex-sparse-solver.test.ts`
- **Tests**: 23/23 passing

---
## Phase 1 Complete
- **Batches**: 5 (w1.1, w1.2, w1.3, w1.4-1.5)
- **All verified**: yes (5/5 task_groups passed on final pass)
- **Recovery events**: batch-p1-w1.3 had a dead implementer (first attempt); replacement implementer completed Wave 1.3 work and fixed a critical architectural bug in the dead implementer's Phase 3 column-swap / x[] re-scatter logic in `_numericLUMarkowitz` (without which `performance_50_node` regressed to residual 11263 vs spec <1e-8).
- **Targeted tests on final state**: sparse-solver.test.ts + complex-sparse-solver.test.ts + newton-raphson.test.ts + rl-iter0-probe.test.ts — 121/125 passing (4 pre-existing baseline failures carried forward, 0 regressions).
---

## Task 2.1.1: Create `ckt-mode.ts`: 14 MODE* constants with ngspice hex verbatim + helpers
- **Status**: complete
- **Agent**: implementer
- **Files created**: `src/solver/analog/ckt-mode.ts`
- **Files modified**: none
- **Tests**: 46/50 passing on targeted suite (4 pre-existing failures from baseline: initTran_transitions_to_initFloat_after_iteration_0, initPred_transitions_to_initFloat_immediately, transient_mode_allows_convergence_without_ladder, ipass_skipped_without_nodesets)
- **Details**: Created ckt-mode.ts with 14 MODE* constants matching ngspice cktdefs.h:165-185 hex values verbatim (verified by direct comparison). Includes INITF_MASK, MODE_ANALYSIS_MASK composites. Exports all 8 helpers: setInitf, setAnalysis, isDcop, isTran, isTranOp, isAc, isUic, initf.

## Task 2.1.2: Migrate LoadContext: remove InitMode type + legacy boolean fields, add cktMode: number
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/load-context.ts`
- **Tests**: 46/50 passing (same 4 pre-existing failures)
- **Details**: Removed InitMode type export, removed fields: iteration, initMode, isDcOp, isTransient, isTransientDcop, isAc. Added cktMode: number as first field. Retained uic: boolean temporarily per spec. LoadContext now matches ngspice CKTcircuit fields accessed inside DEVload.

## Task 2.1.3: Add cktMode field to CKTCircuitContext; mark legacy mirrors @deprecated; init to MODEDCOP | MODEINITFLOAT
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/ckt-context.ts`
- **Tests**: 46/50 passing (same 4 pre-existing failures)
- **Details**: Added cktMode: number field defaulting to MODEDCOP | MODEINITFLOAT. Marked initMode, isDcOp, isTransient, isTransientDcop, isAc as @deprecated with migration guidance. Removed InitMode re-export from load-context.ts (it no longer exports it); defined InitMode locally in ckt-context.ts for transition window. Added import of MODEDCOP, MODEINITFLOAT from ckt-mode.ts. Updated loadCtx initializer to add cktMode field and remove legacy fields (iteration, initMode, isDcOp, isTransient, isTransientDcop, isAc).

## Task 2.1.4: Collapse ctx.noncon dual-storage to accessor; add troubleNode field
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/ckt-context.ts`
- **Tests**: 46/50 passing (same 4 pre-existing failures)
- **Details**: Converted noncon from plain field (noncon: number = 0) to getter/setter pair forwarding through loadCtx.noncon.value — single storage location per ngspice CKTnoncon (C3 fix). Added troubleNode: number | null field with JSDoc citing ngspice cktload.c:64-65. Initialized troubleNode = null in constructor after enableBlameTracking = false.

## Task 2.2.1: Rewrite `cktLoad` gating
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/solver/analog/ckt-load.ts` — dropped `iteration` param; added imports of MODEDC, MODEINITJCT, MODEINITFIX, MODETRANOP, MODEUIC from ckt-mode.ts; removed legacy field propagation (initMode, isDcOp, isTransient, isTransientDcop, isAc); added `ctx.loadCtx.cktMode = ctx.cktMode` propagation; added null-guard `typeof element.load !== "function"` in device loop; added troubleNode zeroing when `ctx.loadCtx.noncon.value > 0`; replaced nodeset gate with `(ctx.cktMode & MODEDC) && (ctx.cktMode & (MODEINITJCT | MODEINITFIX))`; replaced IC gate with `(ctx.cktMode & MODETRANOP) && !(ctx.cktMode & MODEUIC)` as separate block; removed duplicate `ctx.loadCtx.noncon.value = 0` reset; removed trailing `ctx.noncon = ctx.loadCtx.noncon.value` assignment
  - `src/solver/analog/newton-raphson.ts` — updated both `cktLoad(ctx, 0)` and `cktLoad(ctx, iteration)` call sites to `cktLoad(ctx)` (no iteration arg)
  - `src/solver/analog/__tests__/ckt-load.test.ts` — added MODE* imports from ckt-mode.ts; replaced all `cktLoad(ctx, N)` calls with `cktLoad(ctx)`; updated CKTload tests to set `ctx.cktMode` via bitfields instead of legacy `ctx.isDcOp`/`ctx.initMode`; replaced nodeset/IC describe blocks with bitfield-gated tests (MODEDCOP|MODEINITJCT, MODEDCOP|MODEINITFIX, MODETRANOP without/with MODEUIC); added troubleNode describe block with 2 tests
  - `src/solver/analog/__tests__/test-helpers.ts` — removed dead `ctx.iteration > 0` guard from makeDiode's noncon increment (ctx.iteration no longer exists on LoadContext after Wave 2.1 removed the field)
- **Tests**: 43/47 passing on targeted suite (ckt-load.test.ts + newton-raphson.test.ts); 4 failing are all pre-existing baseline failures (initTran_transitions_to_initFloat_after_iteration_0, initPred_transitions_to_initFloat_immediately, transient_mode_allows_convergence_without_ladder, ipass_skipped_without_nodesets)

## Task 2.3: Wave 2.3 (F3 D1–D5 Engine rewrite — tasks 2.3.1 through 2.3.8)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/solver/analog/dc-operating-point.ts` — tasks 2.3.1, 2.3.2, 2.3.5, 2.3.7
  - `src/solver/analog/analog-engine.ts` — tasks 2.3.3, 2.3.4, 2.3.6
  - `src/solver/analog/newton-raphson.ts` — task 2.3.8
  - `src/solver/analog/__tests__/newton-raphson.test.ts` — updated UIC bypass tests to use cktMode bitfield
- **Tests**: 79/84 passing; 5 failing are all pre-existing baseline failures
- **Changes**:
  - 2.3.1: Rewrote `dcopFinalize` to single `cktLoad(ctx)` after `setInitf(ctx.cktMode, MODEINITSMSIG)`; removed runNR/save-restore dance; removed `exactMaxIterations` parameter from `runNR` since no callers pass true
  - 2.3.2: Gated all 3 `dcopFinalize` call sites on `!ctx.isTransientDcop` (direct/gmin/src convergence paths)
  - 2.3.3: Rewrote `_seedFromDcop` as 3-statement dctran.c:346-350 port; removed `el.accept()` sweep, `_firsttime` write, `seedHistory()` call; added direct `states[1].set(states[0])`
  - 2.3.4: Deleted `_firsttime` field + all 9 read/write sites; removed `firstNrForThisStep`; removed `"transient"` initMode sentinel; rewrote step() branches to use `_stepCount === 0`; added post-NIiter `cktMode = MODETRAN | MODEINITPRED` write (dctran.c:794)
  - 2.3.5: Removed `ctx.isTransient = false` in `runNR`; replaced with `ctx.isTransient = (ctx.cktMode & MODETRAN) !== 0` (derived from cktMode)
  - 2.3.6: `_transientDcop` sets `ctx.cktMode = uic | MODETRANOP | MODEINITJCT`; `dcOperatingPoint` sets `ctx.cktMode = uic | MODEDCOP | MODEINITJCT`; changed `srcFact = params.srcFact ?? 1` to `srcFact = 1` in `_transientDcop`
  - 2.3.7: Converted all 10 `ctx.initMode = "initJct/Float"` writes in sub-solver functions to `setInitf(ctx.cktMode, MODEINITJCT/FLOAT)` + legacy mirror; also converted `cktop` firstMode parameter to bitfield
  - 2.3.8: Changed UIC early-exit gate from `ctx.isDcOp && ctx.loadCtx.uic` to `isTranOp(ctx.cktMode) && isUic(ctx.cktMode)` (AD1 fix); updated test to use `MODETRANOP | MODEUIC | MODEINITJCT`
