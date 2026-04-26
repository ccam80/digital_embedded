# Sparse-Solver Structural Alignment Review — digiTS vs ngspice

**Author:** architect (read-only review)
**Date:** 2026-04-26
**Subject file:** `src/solver/analog/sparse-solver.ts` (~2510 lines)
**ngspice reference set:** `ref/ngspice/src/maths/sparse/{spalloc.c, spbuild.c, spfactor.c, spsolve.c, spsmp.c, sputils.c, spdefs.h}`

This review is intentionally written as an honest counterweight to the four
prior per-area audits (`spec/sparse-solver-parity-audit/01..04*.md`) and the
`spec/lazy-row-link-port.md` proposal. Audits 01–04 used closing verdicts
("semantic equivalence", "no numerical impact", "architectural simplification")
that the project rules ban. Their MATCH counts therefore overstate true
line-for-line port fidelity. This document re-classifies every divergence as
either a literal **PORT** (with line evidence) or a **DIVERGES** call-out, and
itemises the digiTS-only fields that do not exist in ngspice.

The project rule (CLAUDE.md):

> When implementing or fixing any SPICE-derived algorithm … match the
> corresponding ngspice source function exactly … 30 years of SPICE experience
> and painstaking development. Equality or nothing.

By that bar, the current sparse solver is not a port. It is a port-shaped
re-implementation with parallel data structures, eager work, and bookkeeping
fields that ngspice never had. Those extras are listed below as the bug surface
they represent.

---

## A. Top-Level Architecture Comparison

### A.1 `MatrixFrame` vs digiTS field set

ngspice C struct (`spdefs.h:733-788`) is one record per matrix; digiTS
splits it into a constellation of typed arrays on the `SparseSolver` instance.

| ngspice `MatrixFrame` field | digiTS field (`sparse-solver.ts`) | line | Classification |
|---|---|---|---|
| `Size` | `_n` | 149 | PORT |
| `Diag[1..Size]` (`ArrayOfElementPtrs`) | `_diag: Int32Array` (length n) | 94 | PORT (typed-array form) |
| `FirstInCol[1..Size]` | `_colHead: Int32Array` | 92 | PORT |
| `FirstInRow[1..Size]` | `_rowHead: Int32Array` | 90 | PORT |
| `IntToExtRowMap[1..Size]` | `_intToExtRow: Int32Array` | 117 | PORT |
| `ExtToIntRowMap[1..Size]` | `_extToIntRow: Int32Array` | 124 | PORT |
| `IntToExtColMap[1..Size]` | `_preorderColPerm: Int32Array` | 102 | PORT (renamed) |
| `ExtToIntColMap[1..Size]` | `_extToIntCol: Int32Array` | 110 | PORT (renamed) |
| `MarkowitzRow[1..Size]` | `_markowitzRow: Int32Array(n+2)` | 269 | DIVERGES (n+2 vs n+1; sentinel slots) |
| `MarkowitzCol[1..Size]` | `_markowitzCol: Int32Array(n+2)` | 270 | DIVERGES (same) |
| `MarkowitzProd[1..Size+2]` | `_markowitzProd: Int32Array(n+2)` | 273 | PORT (sizing matches `spfactor.c:724` `Size+2`) |
| `Singletons` | `_singletons: number` | 274 | PORT |
| `RelThreshold` | `_relThreshold: number` | 244 | PORT |
| `AbsThreshold` | `_absThreshold: number` | 252 | PORT |
| `Factored` | `_factored: boolean` | 232 | PORT |
| `NeedsOrdering` | `_needsReorder: boolean` | 225 | PORT |
| `Reordered` | (absent, conflated into `_needsReorder` lifecycle) | — | DIVERGES today; PORT after Stage 6A (port spec §6A introduces `_reordered` per `spfactor.c:280` and `sputils.c:189`). |
| `RowsLinked` | added by Stage 1 as `_rowsLinked: boolean` (port spec §1.3.1) | — | DIVERGES today; PORT after Stage 1. |
| `InternalVectorsAllocated` | `_workspaceN !== -1` (proxy) | 236 | DIVERGES (proxy, not flag) |
| `Partitioned` | (absent — Partition path not ported) | — | DIVERGES (out-of-scope per port spec §0.4 + §F.2 escalation) |
| `NumberOfInterchangesIsOdd` | (absent) | — | DIVERGES |
| `Elements`, `Originals`, `Fillins` | added by Stage 4B as `_elements`, `_originals`, `_fillins` instance fields | 2497 | DIVERGES today; PORT after Stage 4B (port spec §4B). Counters incremented at the same sites ngspice does (`spbuild.c:782-790, 847, 870`, `spfactor.c:2799-2829`). |
| `Error`, `SingularRow`, `SingularCol` | added by Stage 6A as `_error`, `_singularRow`, `_singularCol` instance fields plus `FactorResult.error/singularRow/singularCol` | 17-37 | DIVERGES today; PORT after Stage 6A (port spec §6A). Wired at every `Matrix->Error` write site ngspice has. |
| `Intermediate` (RealVector) | `_scratch: Float64Array` | 164 | PORT (renamed) |
| `TrashCan` (sentinel element) | (absent — `allocElement` throws on n===0 instead) | 310-315 | DIVERGES |

### A.2 `MatrixElement` vs digiTS pool

ngspice (`spdefs.h:441-452`):

```
struct MatrixElement {
    RealNumber Real, Imag;
    int Row, Col;
    struct MatrixElement *NextInRow, *NextInCol;
};
```

digiTS (Struct-of-Arrays):

| ngspice element field | digiTS array | line | Classification |
|---|---|---|---|
| `Real` | `_elVal: Float64Array` | 77 | PORT |
| `Imag` | (absent — real-only) | — | DIVERGES (complex factor not ported) |
| `Row` | `_elRow: Int32Array` | 73 | PORT |
| `Col` | `_elCol: Int32Array` | 75 | PORT |
| `NextInRow` | `_elNextInRow: Int32Array` | 81 | PORT |
| `NextInCol` | `_elNextInCol: Int32Array` | 85 | PORT |
| (none) | `_elPrevInRow: Int32Array` | 83 | **DIGITS-ONLY** |
| (none) | `_elPrevInCol: Int32Array` | 87 | **DIGITS-ONLY** |
| (none) | `_elFlags: Uint8Array` (FLAG_FILL_IN bit) | 79 | **DIGITS-ONLY** |
| (none) | `_elFreeHead: number` (free-list head) | 131 | **DIGITS-ONLY** |
| (none) | `_handleTable: Int32Array(n*n)` | 138 | **DIGITS-ONLY** |
| (none) | `_handleTableN: number` | 139 | **DIGITS-ONLY** |
| (none) | `_q: Int32Array(n)` | 158 | **DIGITS-ONLY** |
| (none) | `_pinv: Int32Array(n)` | 157 | **DIGITS-ONLY** |
| (none) | `_elMark: Int32Array(n)` | 277 | **DIGITS-ONLY** (declared, never read; dead) |
| (none) | `_rowToElem: Int32Array(n)` | 282 | **DIGITS-ONLY** (declared, never read; dead) |
| (none) | `_preSolveRhs / _capturePreSolveRhs` | 169-170 | **DIGITS-ONLY** (test capture) |
| (none) | `_preFactorMatrix / _capturePreFactorMatrix` | 181-182 | **DIGITS-ONLY** (test capture) |

### A.3 Cost of the digiTS-only fields (fidelity tax)

Each digiTS-only field is one or more **invariants the implementer must keep
true**. Every place the codebase touches the singly-linked chain has to also
touch the prev-pointer chain, the diag pointer, the handle table, and the
permutation arrays.

1. **`_elPrevInRow` / `_elPrevInCol`** — every chain mutation site
   (`_insertIntoRow`, `_insertIntoCol`, `_removeFromRow`, `_removeFromCol`,
   `_setColLink`, `_setRowLink`, `_exchangeColElements`, `_exchangeRowElements`)
   must do **two writes** for every one ngspice write. The Exchange routines
   explicitly call this out at `sparse-solver.ts:2138-2144`. The C original
   uses pointer-to-pointer `*ElementAboveRow = X`; the JS port emulates with
   `_setColLink`. Every missed back-pointer write is silent corruption.

2. **`_handleTable: Int32Array(n*n)`** — `O(n^2)` memory at `_initStructure`
   (line 968). (a) keyed on **caller-supplied** row/col (line 333) but the
   column chain walk just below is keyed on the **internal** column post-
   preorder (line 325 vs 328). Stale entries after preorder swap are not
   invalidated. (b) The dual code paths in `allocElement` (lines 317-321
   vs 325-338) double the verification surface.

3. **`_q` / `_pinv`** — written at line 2408-2409 inside
   `_exchangeRowsAndCols`, never read by any production code path. ngspice
   handles permutation entirely through `IntToExtRowMap` / `IntToExtColMap`.
   `solve()` at sparse-solver.ts:572-573 reads `_intToExtRow` and
   `_preorderColPerm`, never `_q` or `_pinv`. Dead bookkeeping.

4. **`_elMark`, `_rowToElem`** — declared at 277 and 282, allocated in
   `_initStructure` (963-964) and `_allocateWorkspace` (1190-1191), never
   read. Dead.

5. **`_elFreeHead` (free-list)** — needed only because `_createFillin`
   theoretically might want to recycle slots after `spStripFills`-equivalent
   teardown. We have no `spStripFills` equivalent; the free-list head is
   never advanced past `-1` in any current production path.

6. **Capture buffers** (`_preSolveRhs`, `_preFactorMatrix`,
   `enablePreFactorMatrixCapture`, `_takePreFactorSnapshotIfEnabled`,
   `getPreSolveRhsSnapshot`, `getPreFactorMatrixSnapshot`,
   `enablePreSolveRhsCapture`, `getCSCNonZeros`) are pure test
   instrumentation. They occupy ~80 lines (864-931) inside the production
   solver class. ngspice has no equivalent.

---

## B. Lifecycle Alignment

### B.1 Phase ordering — side by side

| Phase | ngspice ordering | digiTS ordering | Verdict |
|---|---|---|---|
| Allocate | `spCreate` zero-fills MatrixFrame, sets `NeedsOrdering=YES, RowsLinked=NO, Reordered=NO, InternalVectorsAllocated=NO`. `spalloc.c:160-200` | `_initStructure` allocates all arrays including `_handleTable(n*n)`, `_intToExtRow`, `_preorderColPerm`, `_markowitz*[n+2]`, `_pinv`, `_q`, `_elMark`, `_rowToElem`. Sets `_needsReorder = true`, `_factored = false`, `_didPreorder = false`. `sparse-solver.ts:937-996` | DIVERGES. ngspice defers Markowitz/Intermediate vectors until `spcCreateInternalVectors` runs from inside `spOrderAndFactor`. digiTS allocates them up-front. |
| Stamping | `spcCreateElement` (`spbuild.c:768-872`) — **two branches** on `RowsLinked`. If `RowsLinked == NO` (assembly time), inserts into column chain only, sets `Diag[Row]` if diagonal, sets `NeedsOrdering = YES`. Row chain not touched. | `allocElement` (sparse-solver.ts:304-375) — single branch: always calls `_insertIntoRow` and `_insertIntoCol`, sets `_diag[internalCol]` if `row === internalCol`, sets `_needsReorder = true`. | DIVERGES. digiTS builds row chains EAGERLY at every stamp. ngspice builds them once via `spcLinkRows` at first factor entry. |
| Re-stamping (NR loop) | `spClear` (`spbuild.c:96-142`) walks `FirstInCol[I]` for `I = Size..1` and zeros `pElement->Real`. Sets `Factored = NO`. Does NOT touch `NeedsOrdering`. | `_resetForAssembly` (sparse-solver.ts:1005-1011) loops `for e = 0..elCount` and zeros `_elVal[e]`. RHS zeroed separately at line 422. | DIVERGES. ngspice clears via chain walk; digiTS clears the whole pool linearly. RHS-zero strategy diverges (digiTS zeros RHS in `beginAssembly`; ngspice expects the caller to manage RHS). |
| Preorder | `spMNA_Preorder` (`sputils.c:177-230`) — runs **once**. `if (Matrix->RowsLinked) return;` at line 187 — preorder is gated to before row-link. Sets `Reordered = YES`. Calls `SwapCols` (`sputils.c:283-301`) per pair. SwapCols does NOT touch row chains and does NOT rewrite `pElement->Col`. | `preorder()` (sparse-solver.ts:708-757) — gated by `_didPreorder`. `_swapColumns` (lines 813-834) DOES rewrite `_elCol[e]` for every element on the two swapped chains AND DOES NOT touch row chains. Then at line 756 calls `_linkRows()` to rebuild row chains from column structure. | DIVERGES. The `_linkRows()` call is the workaround acknowledged in `lazy-row-link-port.md`; the `_elCol[e]` rewrite loop is a second workaround for the same root cause. |
| Markowitz precompute | None at preorder. Done at `spfactor.c:255-256` inside `spOrderAndFactor`, gated AFTER reorder fall-through reaches the reorder loop. | `finalize()` (sparse-solver.ts:447-482) — recomputes Markowitz row/col/prod from row and column chains. RHS captured for `_preSolveRhs` at the same moment. | DIVERGES. Earliest possible precompute. ngspice precomputes only when about to use them. The early precompute means every NR-iteration re-stamp re-runs `finalize()` and re-walks every chain twice. |
| Factor — reuse path | `spFactor` (`spfactor.c:323-414`) — checked at line 333 `if (Matrix->NeedsOrdering) return spOrderAndFactor(...)`. Direct dispatch. Otherwise runs `RealRowColElimination` per step. **`spOrderAndFactor`** (`spfactor.c:214-228`) ALSO has the reuse loop inline as the `if (!NeedsOrdering)` branch — identical body, shared `Step` counter falls through to the reorder loop on rejection. | `factor()` (sparse-solver.ts:503-538) — checks `if (this._needsReorder \|\| !this._factored) return factorWithReorder()`. Otherwise calls `factorNumerical -> _numericLUReusePivots`. On rejection (`needsReorder: true, rejectedAtStep: k`), calls `_numericLUMarkowitz(k)` directly, bypassing `factorWithReorder`. | DIVERGES. Two-tiered dispatch where ngspice has one entry (`spOrderAndFactor`) with two consecutive loops sharing `Step`. The C3 fix was an attempt to emulate the shared-Step semantics across the dispatch boundary, and that boundary is itself the divergence. |
| Factor — reorder path | `spOrderAndFactor` `spfactor.c:240-281`: gated `if (!RowsLinked) spcLinkRows`. Then `spcCreateInternalVectors` if not yet allocated. Then `CountMarkowitz`, `MarkowitzProducts`, then per-step loop. On `Done:` sets `NeedsOrdering = NO; Reordered = YES; Factored = YES`. | `factorWithReorder` (sparse-solver.ts:1427-1448): applies gmin, takes pre-factor snapshot, allocates workspace if `_needsReorder`, calls `_numericLUMarkowitz()`. On success sets `_needsReorder = false; _factored = true`. | DIVERGES. Does not gate on `_rowsLinked` (no such flag), does not call `spcLinkRows`, does not call `spcCreateInternalVectors`. `Reordered` is not tracked. |
| LoadGmin | `LoadGmin` (`spsmp.c:422-440`) — called from `SMPluFac` (`spsmp.c:173`) and `SMPreorder` (`spsmp.c:197`). Walks `Diag[I]` for `I = Size..1`. Guards on `Gmin != 0.0` at entry. | `_applyDiagGmin` (sparse-solver.ts:2477-2488) — called from `factorWithReorder:1433` and `factorNumerical:1457`. Walks `_diag[i]` for `i = n-1..0`. Guards on `gmin !== 0`. | PORT (after this session's loop-direction fix). |
| Solve | `spSolve` (`spsolve.c:127-191`). Permute RHS in (reverse), forward eliminate (forward), backward substitute (reverse), permute solution out (reverse). | `solve()` (sparse-solver.ts:566-653) — same four phases. Loop direction matches ngspice for all four after the recent fixes; early exit `if (n === 0) return` at line 568 is digiTS-only. | PORT (modulo the early-exit guard). |
| Strip | `spStripMatrix` (`sputils.c:1106-1145`) — sets `RowsLinked = NO`, `NeedsOrdering = YES`, zeros `Elements`, `Originals`, `Fillins`, resets element/fill-in lists, NULLs all `FirstInRow/Col/Diag`. | `invalidateTopology` (sparse-solver.ts:666-674) — sets `_structureEmpty = true`, `_factored = false`, `_didPreorder = false`, `_needsReorder = true`. Does NOT clear `_rowHead`, `_colHead`, `_diag`, free-list, pool counters. | DIVERGES. ngspice keeps the matrix frame and resets list cursors so the next allocation reuses the existing pool. digiTS silently throws away the existing pool. |

### B.2 The lazy row-link mismatch (the load-bearing one)

ngspice's `RowsLinked` flag is the single point of truth for whether row
chains exist. `spcCreateElement` checks it (`spbuild.c:776`) and silently
omits the row insert when `RowsLinked == NO`. `spcLinkRows` is called once,
gated, from `spOrderAndFactor` (`spfactor.c:246-247`), after preorder swaps
have settled but before any factor walks rows.

digiTS has no `_rowsLinked` field. `allocElement` always inserts into the
row chain (line 364). `_swapColumns` does NOT update row chains (it only
walks the two swapped column chains to rewrite `_elCol[e]` at lines 830-833).
`preorder()` then calls `_linkRows()` to rebuild row chains from column
structure (line 756) — this is the workaround that the prior agent's
`lazy-row-link-port.md` proposes to revert by adopting ngspice's lazy model.

The eager row link **forces the `_swapColumns` `_elCol[e]` rewrite loop**,
which in turn imposes the post-preorder `_linkRows()` rebuild, which in turn
means row chains are constructed twice (once at allocation, once at
preorder) **plus the rewrite cost on every preorder swap**. None of that
is in ngspice.

---

## C. Per-Function Divergence Catalog

Format: digiTS function (file:lines) → ngspice counterpart → classification.

### C.1 Allocation / build

| digiTS function | ngspice counterpart | digiTS lines | ngspice lines | Classification |
|---|---|---|---|---|
| `allocElement` | `spGetElement` -> `spcFindElementInCol` -> `spcCreateElement` (RowsLinked=NO branch) | 304-375 | spbuild.c:265-318, 363-393, 840-871 | DIVERGES — handle-table fast path, eager row-chain insert, decentralised `_diag` set |
| `stampElement` | `*ElementPtr += val` macro | 384-386 | spdefs.h | PORT |
| `stampRHS` | `RHS[row] += val` (caller) | 391-393 | niiter.c idiom | PORT |
| `beginAssembly` | `SMPclear` (`spsmp.c:141-147`) -> `spClear` (`spbuild.c:96-142`) on every NR re-stamp; on first call (`_structureEmpty`) the size-allocation portion mirrors `spCreate` (`spalloc.c:160-200`) plus deferred `spcCreateInternalVectors` (`spfactor.c:706-747`). The RHS-zero loop at line 422 has NO ngspice home — ngspice's NR loop in `niiter.c` resets RHS itself; `spClear` does not touch RHS. | DIVERGES today; resolved by Stage 4A which renames `beginAssembly` to mirror the `SMPclear` entry point and removes the RHS-zero (port spec §4A). The first-call `_initStructure` allocation path stays inside `beginAssembly`. |
| `finalize` | `CountMarkowitz` + `MarkowitzProducts` from inside `spOrderAndFactor` | 447-482 | spfactor.c:782-826, 866-896 | DIVERGES — runs at the wrong lifecycle moment |
| `_initStructure` | `spCreate` partial + `spcCreateInternalVectors` | 937-996 | spalloc.c:160-200, spfactor.c:706-747 | DIVERGES — allocates more than spCreate and earlier than spcCreateInternalVectors |
| `_resetForAssembly` | `spClear` | 1005-1011 | spbuild.c:96-142 | DIVERGES today; port spec Stage 5A converts the body to ngspice's `for I = Size; I > 0; I-- { for pE = FirstInCol[I]; pE != NULL; pE = pE->NextInCol { pE->Real = 0 } }` chain walk. |
| `_newElement` | `spcGetElement` (subset) | 1021-1039 | spalloc.c:310-364 | DIVERGES — also resets all link fields and uses free-list head |
| `_insertIntoRow` | inline within `spcCreateElement` linked branch | 1051-1064 | spbuild.c:809-837 | DIVERGES — maintains `_elPrevInRow` |
| `_insertIntoCol` | inline within `spcCreateElement` | 1112-1125 | spbuild.c:805-807 | DIVERGES — maintains `_elPrevInCol`; also sorted-insert (ngspice inserts at head via `*LastAddr`) |
| `_removeFromRow` | inline within `ExchangeRowElements` | 1127-1133 | implicit | DIVERGES |
| `_removeFromCol` | inline within `ExchangeColElements` | 1135-1141 | implicit | DIVERGES |
| `_growElements` | `spcGetElement` block-allocation logic | 1143-1170 | spalloc.c:319-326, 402-446 | DIVERGES |
| `_createFillin` | `CreateFillin` + `spcCreateElement` fillin branch | 1083-1109 | spfactor.c:2799-2829, spbuild.c:776-790 | DIVERGES — duplicates `_diag[col] = fe` set (workaround) |

### C.2 Preorder

| digiTS function | ngspice counterpart | digiTS lines | ngspice lines | Classification |
|---|---|---|---|---|
| `preorder` | `spMNA_Preorder` | 708-757 | sputils.c:177-230 | DIVERGES — calls `_linkRows()` at the end (workaround) |
| `_findTwin` | `CountTwins` (returning ptr to one twin) | 790-797 | sputils.c:243-271 | PORT (subset — does not count to 2) |
| `_swapColumns` | `SwapCols` | 813-834 | sputils.c:283-301 | DIVERGES — rewrites `_elCol[e]` for swapped chains (workaround) |
| `_linkRows` | `spcLinkRows` | 768-783 | spbuild.c:907-932 | PORT (with doubly-linked prev maintenance added — DIVERGES on prev) |
| `_findDiagOnColumn` | inline `spcFindElementInCol(Col, Col, NO)` | 843-850 | spbuild.c:362-393 | PORT (specialized) |

### C.3 Factor + elimination

| digiTS function | ngspice counterpart | digiTS lines | ngspice lines | Classification |
|---|---|---|---|---|
| `factor` | (none — split entry) | 503-538 | n/a | DIVERGES |
| `factorWithReorder` | `SMPreorder` body — `LoadGmin` + `spOrderAndFactor` | 1427-1448 | spsmp.c:194-200, spfactor.c:192-284 | DIVERGES — does not gate on `_rowsLinked`, no `spcLinkRows`, no `spcCreateInternalVectors` |
| `factorNumerical` | `SMPluFac` body — `LoadGmin` + `spFactor` | 1454-1468 | spsmp.c:169-175, spfactor.c:323-414 | DIVERGES — `spFactor` has the partition / direct-addressing scatter-gather optimisation; digiTS just runs the Markowitz-style elimination unconditionally |
| `_numericLUMarkowitz` | `spOrderAndFactor` reorder loop body | 1204-1303 | spfactor.c:240-281 | DIVERGES — accepts `startStep` parameter to resume; ngspice uses shared local `Step` |
| `_numericLUReusePivots` | `spOrderAndFactor` reuse loop (`!NeedsOrdering` branch) | 1330-1417 | spfactor.c:214-228 | DIVERGES — returns early on missing fill-in or weak pivot |
| `_applyDiagGmin` | `LoadGmin` | 2477-2488 | spsmp.c:422-440 | PORT (after this session's loop-direction fix) |

### C.4 Markowitz + pivot search

| digiTS function | ngspice counterpart | digiTS lines | ngspice lines | Classification |
|---|---|---|---|---|
| `_countMarkowitz` | `CountMarkowitz` | 1573-1605 | spfactor.c:782-826 | PORT |
| `_markowitzProducts` | `MarkowitzProducts` | 1614-1631 | spfactor.c:866-896 | PORT |
| `_searchForPivot` | `SearchForPivot` | 1641-1653 | spfactor.c:947-994 | PORT |
| `_searchForSingleton` | `SearchForSingleton` | 1669-1764 | spfactor.c:1041-1172 | PORT (preserves the inverted-condition bug at spfactor.c:1116) |
| `_quicklySearchDiagonal` | `QuicklySearchDiagonal` | 1773-1873 | spfactor.c:1255-1383 | PORT |
| `_searchDiagonal` | `SearchDiagonal` | 1878-1923 | spfactor.c:1604-1663 | PORT |
| `_searchEntireMatrix` | `SearchEntireMatrix` | 1931-1984 | spfactor.c:1730-1809 | DIVERGES today; PORT after Stage 6A (port spec §6A) — `_error`/`_singularRow`/`_singularCol` writes restored at every site `spfactor.c` does, distinguishing `spSINGULAR`/`spSMALL_PIVOT`/`spZERO_DIAG`. |
| `_findLargestInCol` | `FindLargestInCol` | 1507-1516 | spfactor.c:1849-1863 | PORT |
| `_findBiggestInColExclude` | `FindBiggestInColExclude` | 1528-1557 | spfactor.c:1913-1944 | PORT |
| `_exchangeRowsAndCols` | `ExchangeRowsAndCols` | 2348-2410 | spfactor.c:1986-2070 | DIVERGES — writes `_q[step]` and `_pinv[origRow]` (digiTS-only) |
| `_spcRowExchange` | `spcRowExchange` | 2009-2057 | spfactor.c:2110-2164 | PORT |
| `_spcColExchange` | `spcColExchange` | 2062-2110 | spfactor.c:2204-2258 | PORT |
| `_setColLink`, `_setRowLink` | inline `*ElementAboveRow = X` | 2117-2131 | spfactor.c:2302-2385, 2431-2514 | DIVERGES — wraps doubly-linked prev maintenance |
| `_exchangeColElements` | `ExchangeColElements` | 2146-2240 | spfactor.c:2302-2385 | DIVERGES — every C `*ElementAboveRow = X` becomes `_setColLink + _elPrevInCol = ...` |
| `_exchangeRowElements` | `ExchangeRowElements` | 2247-2341 | spfactor.c:2431-2514 | DIVERGES — symmetric mirror |
| `_updateMarkowitzNumbers` | `UpdateMarkowitzNumbers` | 2418-2458 | spfactor.c:2713-2760 | PORT |

### C.5 Solve + RHS

| digiTS function | ngspice counterpart | digiTS lines | ngspice lines | Classification |
|---|---|---|---|---|
| `solve` (RHS perm in) | spsolve.c:149-151 | 590 | spsolve.c:149-151 | PORT (after loop-direction fix) |
| `solve` (forward elim) | spsolve.c:154-170 | 608-620 | spsolve.c:154-170 | PORT |
| `solve` (back-sub) | spsolve.c:173-183 | 635-643 | spsolve.c:173-183 | PORT |
| `solve` (solution perm out) | spsolve.c:186-188 | 652 | spsolve.c:186-188 | PORT (after loop-direction fix) |
| `solve` (n===0 early exit) | (none) | 568 | n/a | DIVERGES today; port spec Stage 6B deletes the guard per banned-pattern guard rule #1. `spSolve` (`spsolve.c:127-191`) has no such guard. |
| `setPivotTolerances` | spOrderAndFactor entry threshold validation | 689-692 | spfactor.c:204-211 | PORT |
| `forceReorder` | NISHOULDREORDER (niiter.c-side flag) | 696-700 | niiter.c:858 | PORT |
| `invalidateTopology` | `spStripMatrix` | 666-674 | sputils.c:1106-1145 | DIVERGES today; port spec Stage 4C expands the body to clear every field ngspice's `spStripMatrix` clears (`_rowHead`, `_colHead`, `_diag`, `_elements`/`_originals`/`_fillins` counters, pool reset, free-list reset, etc.). |

### C.6 DigiTS-only (no ngspice counterpart)

- `_takePreFactorSnapshotIfEnabled` (897-911) — test instrumentation
- `enablePreSolveRhsCapture` (866-870) — test instrumentation
- `getPreSolveRhsSnapshot` (873-874) — test instrumentation
- `enablePreFactorMatrixCapture` (877-879) — test instrumentation
- `getPreFactorMatrixSnapshot` (887-889) — test instrumentation
- `getCSCNonZeros` (918-930) — test instrumentation
- `getRhsSnapshot` (862-864) — test instrumentation
- Accessors `dimension`, `markowitzRow`, `markowitzCol`, `markowitzProd`, `singletons`, `elementCount` (854-860, 2497-2508) — test instrumentation
- `_growElements` (1143-1170) — pool growth
- `_allocateWorkspace` (1181-1192) — workspace re-allocation guard

---

## D. Bug Suspicion List

This is hypothesis, not diagnosis. Each entry names the structural delta and
the test it most plausibly affects. Treat as "first place to instrument with
the ngspice harness", not as "fix this and move on".

### D.1 Open issue: 1-ULP failures on `rc-transient`, `rlc-oscillator`

Symptom: `expect(absDelta).toBe(+0)` failing with values in `{1.03e-25,
2.17e-19}`.

**Hypothesis A — eager Markowitz precompute changes pivot order.** `finalize()`
at sparse-solver.ts:447-482 calls the Markowitz scan over the full matrix
and **excludes** prior fill-ins (the `FLAG_FILL_IN` filter at line 458 and
466). ngspice (`spfactor.c:255-256`) calls `CountMarkowitz` from inside
`spOrderAndFactor` AFTER `spcLinkRows` and AFTER prior fill-ins have been
integrated into the topology — there is no fill-in distinction in
`CountMarkowitz` (`spfactor.c:792-810`). The two count strategies can report
different `MarkowitzRow[i]` for steady-state matrices that have been
factored before, leading to a different pivot at the first reorder of the
new transient step. Different pivots mean different elimination order and
different round-off accumulation. Evidence: sparse-solver.ts:457-458 vs
spfactor.c:792-801.

**Hypothesis B — `_q[step]` / `_pinv[origRow]` writes leak invalidations.**
`_exchangeRowsAndCols` writes these at line 2408-2409 even on the
"already-at-(step,step)" early-return path (line 2354-2356). Low likelihood
but worth a `Grep` for `_q\[` and `_pinv\[` reads outside
`_exchangeRowsAndCols`.

**Hypothesis C — handle table staleness post-preorder.** `_handleTable` at
`sparse-solver.ts:333` is keyed on the caller's original (row, col), but
`allocElement` at line 325 translates `col -> internalCol` via `_extToIntCol`.
After a preorder swap, the stored pool index is correct only because
`_swapColumns` did the rewrite-`_elCol` workaround. Removing that
workaround without also lazy-linking rows would silently read the wrong
cell. This is the *reason the workaround exists*, and explains why the
system is fragile under modification.

### D.2 Open issue: `opamp-inverting` 4-decade RHS gap

Outside `sparse-solver.ts`. No structural divergence inside the solver
explains a 4-decade RHS magnitude mismatch at iteration 0. Candidates:

- `newton-raphson.ts` source-stepping ladder (1.0 vs 0.0001 looks like
  source-stepping factor `srcFact = 1e-4` applied where ngspice has
  `srcFact = 1`)
- `dc-operating-point.ts` initial sweep schedule
- The code that calls `stampRHS` in the linear-source load path

NOT a sparse-solver bug. Direct port does not resolve it.

### D.3 Open issue: `mosfet-inverter` VBD state-init

State initialization disagreement. Outside `sparse-solver.ts`. Check
`mos1.ts` / `mos2.ts` device-state initial value vs ngspice `MOS1getic`,
`MOS2getic`. Not addressed by the port.

### D.4 Open issue: `diode-bridge` parity test "hang"

Per session findings §3.3, this is in the comparison harness, not the
solver. Not addressed by the port.

### D.5 Open issue (added by this review): preorder oscillation on `_didPreorder` reset

`preorder()` at sparse-solver.ts:709 returns early on `_didPreorder = true`.
`invalidateTopology()` at line 671 resets `_didPreorder = false`. ngspice's
`Reordered` flag is set by `spMNA_Preorder` at `sputils.c:189` and never
reset. Missing the persistent `Reordered` flag adds a second risk surface
beyond the StartAt cursor.

---

## E. Honesty Section — Where I Disagree With the Prior Audits

### E.1 `01-markowitz-search.md` § "Conclusion"

> Core Markowitz pivot algorithm faithfully ported. All DIFFs are safety
> additions, equivalent transformations, or minor reorganization. **No
> numerical divergences.**

DISAGREE on closing verdict. Per project rules, "no numerical divergences"
cannot be a closing verdict on a parity item. The pivot search bodies
(C.4) are largely PORT, but:

- `_searchEntireMatrix` line 1980-1984: returns `-1` for SINGULAR, returns
  `pLargestElement` otherwise. ngspice writes `Matrix->Error = SINGULAR`
  alongside returning `pLargestElement`. The caller cannot distinguish
  "small pivot fallback" from "true singular" — so consumers (NR loop,
  dynamic gmin ladder) cannot apply the `spSMALL_PIVOT` warning logic that
  ngspice does. **Reclassified as DIVERGES.**

### E.2 `02-factor-elimination.md` § "Architectural Divergences (NOT BUGS)"

Five items listed as "architectural divergences (not bugs)":

1. **Dispatch order** — closing verdict "terminal outcomes identical".
   DISAGREE. The C3 fix in this session is itself evidence that "terminal
   outcomes identical" was wrong — when the reuse path half-mutated `_elVal`
   before rejection, the outcomes diverged because the resumed reorder ran
   on garbage. **Keep classified as DIVERGES.**
2. **Resumption handling** — `_numericLUMarkowitz(rejectedAtStep)` vs
   shared `Step` counter. DISAGREE on closing verdict. ngspice never leaves
   `spOrderAndFactor`, so its local variables stay live; digiTS leaves the
   function and re-enters with state recovered from instance fields.
   **Keep classified as DIVERGES.**
3. **Indexing convention** — closing verdict "semantic equivalence
   preserved at every comparison". This is a banned closing verdict.
   **Keep as DIVERGES.**
4. **Doubly-linked adaptation** — closing verdict "Control flow and chain
   ordering identical to ngspice". DISAGREE — the prev-pointer maintenance
   is itself extra work, extra invariants, extra surface area for bugs.
   **Keep as DIVERGES.**
5. **Diagonal fill-in recording** — closing verdict "safety check to
   prevent solve() reading `elVal[-1]`". DISAGREE — the reason this safety
   check exists is that diag maintenance is **decentralised** in digiTS.
   ngspice centralises it inside `spcCreateElement`. The fix is to remove
   the duplication. **Keep as DIVERGES.**

### E.3 `02-factor-elimination.md` § "Conclusion"

> NO ARCHITECTURAL GAPS OR NUMERICAL BUGS DETECTED IN THE ELIMINATION FLOW.

DISAGREE. Two architectural gaps:

- The dispatch order between `factor()`, `factorWithReorder()`,
  `factorNumerical()`, `_numericLUMarkowitz()` is not the ngspice
  `spOrderAndFactor` flow. The C3 bug was born from that gap.
- The eager row link at `allocElement` time (and the workaround chain it
  imposes) is the architectural mismatch acknowledged in
  `lazy-row-link-port.md`.

### E.4 `03-build-clear-preorder.md` § "Architectural Findings"

> Optimization layers (caching, precomputation, memory strategy): DIFF but
> semantically equivalent

DISAGREE on closing verdict. "Semantically equivalent" is banned. The
handle table, `finalize()` Markowitz precompute, and pool linear-zero are
each a digiTS-only invariant the maintainer must keep true and a workspace
allocated at the wrong lifecycle moment. Each is in scope for the port.

### E.5 `04-solve-rhs.md` § "Summary"

> Initialization/output permutation loops: DIFF in direction/indexing,
> MATCH in semantic effect.

DISAGREE on closing verdict for "MATCH in semantic effect" (banned). After
this session's loop-direction fix the bodies are PORT; calling them MATCH
in the original audit was correct only after the fix landed. Pre-fix, the
phrasing masked a real divergence.

### E.6 `lazy-row-link-port.md`

**Right:** The diagnosis that eager row-linking is the load-bearing
mismatch is correct.

**Missed:**

- Does not remove `_q` / `_pinv` (digiTS-only and not even read).
- Does not address the doubly-linked prev pointers (the cleaner approach is
  to delete `_elPrevInRow`/`_elPrevInCol` entirely and port the C
  `*PtrToPtr = X` idiom faithfully).
- Does not address the dispatch-order divergence between
  `factor`/`factorWithReorder`/`factorNumerical`/`_numericLUMarkowitz`.
- Preserves the handle table.
- Does not address the `finalize()` Markowitz precompute divergence
  (Hypothesis D.1.A).

The `lazy-row-link-port.md` is one stage of a multi-stage port.

---

## F. Escalations for User Decision

These are items where I would have been tempted to use a banned closing
verdict. Per project rules they belong here as candidates for
`spec/architectural-alignment.md` (which only the user adds).

1. **Real-only matrix factor.** ngspice supports complex-arithmetic factor.
   digiTS does not. The port spec assumes real-only. Decision required.

2. **Partition / direct-addressing scatter-gather.** ngspice `spFactor`
   has the partition-decided direct-addressing fast path
   (`spfactor.c:337, 352-410`). digiTS does not. Decision required.

3. **`TrashCan` element.** ngspice's `spbuild.c:182-200` returns a
   pointer to a sentinel "trash can" element when the caller passes
   `Row == 0` or `Col == 0`. digiTS throws on `_n === 0` (line 310-315)
   but has no ground-row guard at stamp time. Decision required.

4. **Test-only instrumentation in production class.** 80+ lines of
   production-class surface area. Decision required: port the solver
   class to be ngspice-shaped (no instrumentation) and host the
   instrumentation behind a wrapper, OR accept it as a digiTS-only
   surface and document it in `architectural-alignment.md`?

5. **`_didPreorder` lifetime.** ngspice's `Reordered` flag is set
   (`sputils.c:189`) and never reset. digiTS resets `_didPreorder` in
   `invalidateTopology`. Decision required.

6. **`beginAssembly` ngspice home (resolved, recorded for traceability).**
   Originally flagged as having no direct ngspice equivalent. Re-examined:
   the steady-state body maps to `SMPclear` (`spsmp.c:141-147`) -> `spClear`
   (`spbuild.c:96-142`); the first-call allocation block maps to `spCreate`
   (`spalloc.c:160-200`) plus deferred `spcCreateInternalVectors`
   (`spfactor.c:706-747`); the RHS-zero loop has no ngspice home and is
   removed by port spec Stage 4A. **No escalation required** — the port
   spec restructures `beginAssembly` to mirror the `SMPclear` entry and
   keeps the first-call alloc behind the `_structureEmpty` gate.

---

## References

- `src/solver/analog/sparse-solver.ts:73-282` — full field declaration block
- `src/solver/analog/sparse-solver.ts:304-375` — `allocElement`
- `src/solver/analog/sparse-solver.ts:447-482` — `finalize`
- `src/solver/analog/sparse-solver.ts:503-538` — `factor` dispatch
- `src/solver/analog/sparse-solver.ts:566-653` — `solve`
- `src/solver/analog/sparse-solver.ts:708-757` — `preorder`
- `src/solver/analog/sparse-solver.ts:768-783` — `_linkRows`
- `src/solver/analog/sparse-solver.ts:813-834` — `_swapColumns`
- `src/solver/analog/sparse-solver.ts:1083-1109` — `_createFillin`
- `src/solver/analog/sparse-solver.ts:1204-1303` — `_numericLUMarkowitz`
- `src/solver/analog/sparse-solver.ts:1330-1417` — `_numericLUReusePivots`
- `src/solver/analog/sparse-solver.ts:2348-2410` — `_exchangeRowsAndCols`
- `src/solver/analog/sparse-solver.ts:2477-2488` — `_applyDiagGmin`
- `ref/ngspice/src/maths/sparse/spdefs.h:69` — `IS_FACTORED` macro
- `ref/ngspice/src/maths/sparse/spdefs.h:733-788` — `MatrixFrame`
- `ref/ngspice/src/maths/sparse/spalloc.c:160-200` — `spCreate`
- `ref/ngspice/src/maths/sparse/spbuild.c:96-142` — `spClear`
- `ref/ngspice/src/maths/sparse/spbuild.c:768-871` — `spcCreateElement` (RowsLinked two-branch contract)
- `ref/ngspice/src/maths/sparse/spbuild.c:907-932` — `spcLinkRows`
- `ref/ngspice/src/maths/sparse/spfactor.c:192-284` — `spOrderAndFactor`
- `ref/ngspice/src/maths/sparse/spfactor.c:323-414` — `spFactor`
- `ref/ngspice/src/maths/sparse/spfactor.c:706-747` — `spcCreateInternalVectors`
- `ref/ngspice/src/maths/sparse/sputils.c:177-230` — `spMNA_Preorder`
- `ref/ngspice/src/maths/sparse/sputils.c:283-301` — `SwapCols`
- `ref/ngspice/src/maths/sparse/sputils.c:1106-1145` — `spStripMatrix`
- `ref/ngspice/src/maths/sparse/spsmp.c:169-200` — `SMPluFac` / `SMPreorder`
- `ref/ngspice/src/maths/sparse/spsmp.c:422-440` — `LoadGmin`
- `ref/ngspice/src/maths/sparse/spsolve.c:127-191` — `spSolve`
- `spec/sparse-solver-parity-audit/00-session-findings.md`
- `spec/sparse-solver-parity-audit/01-markowitz-search.md`
- `spec/sparse-solver-parity-audit/02-factor-elimination.md`
- `spec/sparse-solver-parity-audit/03-build-clear-preorder.md`
- `spec/sparse-solver-parity-audit/04-solve-rhs.md`
- `spec/lazy-row-link-port.md`
