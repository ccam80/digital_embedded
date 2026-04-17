# ngspice Alignment — Implementation Progress

**Plan:** `spec/plan.md` (mirror of `spec/ngspice-alignment-master.md`)
**Started:** 2026-04-17

## Phase Structure (per master plan dependency graph)

| Batch | Phase(s) | Task Groups | Status |
|---|---|---|---|
| 1 | Phase 0: Sparse Solver Rewrite | 0.1 (sparse-solver.ts) | pending |
| 2 | Phase 1: CKTCircuitContext + Zero-Alloc | 1.1 (ctx + hot-path) | pending |
| 3 | Phase 2.1 + Phase 3 + Phase 6.1 (parallel after Phase 1) | 2.1, 3.1, 6.1 | pending |
| 4 | Phase 6.2: Element Rewrites (atomic) | 6.2.a, 6.2.b, 6.2.c, 6.2.d | pending |
| 5 | Phase 2.2 + Phase 6.3 (cktLoad + delete loops) | 2.2_6.3 | pending |
| 6 | Phase 4: DC-OP Alignment | 4.1 | pending |
| 7 | Phase 5: Transient Step Alignment | 5.1 | pending |
| 8 | Phase 7.1: Parity Infrastructure | 7.1 | pending |
| 9 | Phase 7.2-7.4: Parity Tests | 7.2a, 7.2b, 7.3a, 7.3b | pending |

## Task Log

(Implementers append per-task status entries here.)

## Task 0.1.1: Replace COO assembly with direct linked-list insertion and handle-based stamp API
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/solver/analog/sparse-solver.ts, src/solver/analog/__tests__/sparse-solver.test.ts
- **Tests**: 54/54 passing

## Task 0.1.2: Drop AMD ordering — Markowitz on original column order; rename _symbolicLU → _allocateWorkspace
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/solver/analog/__tests__/sparse-solver.test.ts
- **Tests**: 57/57 passing

## Task 0.1.3: Build CSC from persistent linked L/U structure for solve only
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/solver/analog/sparse-solver.ts, src/solver/analog/__tests__/sparse-solver.test.ts
- **Tests**: 59/59 passing

## Task 0.2.1: Implement SMPpreOrder on persistent linked lists
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/solver/analog/sparse-solver.ts, src/solver/analog/__tests__/sparse-solver.test.ts
- **Tests**: 65/65 passing
- **Root cause fixed**: _swapColumns now (a) updates _elCol for all elements in swapped chains so _removeFromCol and _updateMarkowitzNumbers see correct column assignments, (b) recomputes _diag for both columns by scanning for elements where _elRow===_elCol after the swap, (c) maintains _preorderColPerm array (new field) tracking internal→original column mapping. solve() applies _preorderColPerm to map internal solution indices back to original variable indices (equivalent to ngspice IntToExtColMap).

## Task 0.3.1: Explicit forceReorder() at ngspice-matching points
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/solver/analog/__tests__/sparse-solver.test.ts, src/solver/analog/__tests__/newton-raphson.test.ts
- **Tests**: 27/27 new NR tests passing (92 total across both files)
- **Notes**: forceReorder() calls at initJct→initFix and initTran (iteration<=0) were already correct in newton-raphson.ts. Added required tests: factor_uses_numeric_path_without_forceReorder, forceReorder_triggers_full_pivot_search (sparse-solver.test.ts); forceReorder_called_on_initJct_to_initFix, forceReorder_called_on_initTran_first_iteration (newton-raphson.test.ts). Also fixed 5 pre-existing regressions: applyNodesetsAndICs tests used cooCount (removed by prior agent), updated to elementCount.

## Task 0.3.2: E_SINGULAR recovery re-loads then re-factors
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/solver/analog/newton-raphson.ts, src/solver/analog/__tests__/newton-raphson.test.ts
- **Tests**: 92/92 passing
- **Change**: Replaced immediate factor() retry with forceReorder() + continue, matching ngspice niiter.c:888-891. The continue returns to top of NR loop body (Step A: clear noncon, Step B: re-execute stampAll) before re-factoring. Also updated nr_emits_singular_diagnostic_when_reorder_also_fails test to use lastFactorUsedReorder===true to trigger the error path (consistent with new continue semantics).
