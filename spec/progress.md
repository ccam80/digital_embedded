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
