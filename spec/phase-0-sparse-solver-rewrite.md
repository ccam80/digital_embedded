# Phase 0: Sparse Solver Rewrite — Persistent Linked Lists

## Overview

Replace the COO→CSC assembly pipeline with persistent linked lists as the primary matrix format, matching ngspice's `spMatrix` architecture. Drop AMD ordering in favor of pure Markowitz pivot selection on the original (preordered) column order. Implement real `SMPpreOrder` for diagonal zero elimination. This is the foundation for all subsequent phases.

**Testing surfaces:** Phase 0 is an engine-internal refactor. Per the master plan Testing Surface Policy, Phase 0 is satisfied by unit tests defined below (headless API surface) plus Phase 7 parity tests as the E2E surface. No per-phase MCP or Playwright tests are required.

## Architectural Decision: Single Persistent Linked Structure

The sparse solver uses a **single persistent linked structure** as the canonical matrix representation, matching ngspice `spMatrix`:
- The current ephemeral `_elRow`/`_elNextInRow`/`_colHead`/`_elCol`/`_elNextInCol`/`_elVal` pool becomes the **primary matrix storage**, persistent across `beginAssembly` / `stamp` / `finalize` cycles.
- `_buildLinkedMatrix()` is **deleted** (no longer a rebuild-from-CSC helper).
- L/U fill-in entries are inserted into the **same persistent pool** during `_numericLUMarkowitz()`. Fill-in elements carry a flag distinguishing them from original A-matrix elements, so `beginAssembly` can zero only A-entries and remove fill-in entries on reassembly.
- Each pool element stores a `lValueIndex: number` and `uValueIndex: number` (or `-1` if the element is A-matrix-only) to enable O(1) value scatter from the linked structure into CSC L/U arrays in `_numericLUReusePivots()`.

## Stamp API: Handle-Based (matches ngspice spGetElement)

Replace the value-addressed `stamp(row, col, value)` API with a two-phase API matching ngspice:
- `allocElement(row, col): number` — called once at compile time; returns a stable element handle (index into the pool). May allocate a new pool entry or return an existing one.
- `stampElement(handle: number, value: number): void` — O(1) unconditional. Called in the NR hot path.

Callers (MNAAssembler, cktLoad, every element's `load()`) cache handles on first compile and use `stampElement` for all subsequent stamps. This matches ngspice `spGetElement` returning a cached pointer used by `*ElementPtr += value` for O(1) hot-path stamps.

## Wave 0.1: Persistent Linked-List Matrix Format

### Task 0.1.1: Replace COO assembly with direct linked-list insertion and handle-based stamp API

- **Description**: Remove COO triplet arrays (`_cooRows`, `_cooCols`, `_cooVals`, `_cooCount`). Introduce the two-phase stamp API (see Overview — "Stamp API: Handle-Based"):
  - `allocElement(row: number, col: number): number` — inserts or finds an element in the persistent linked structure at (row, col) and returns a stable handle (pool index). Called at compile time by every caller (element factories, MNAAssembler).
  - `stampElement(handle: number, value: number): void` — O(1) accumulate onto element at the given handle. Called in the hot path.
  `beginAssembly()` zeros all element values and the RHS vector but preserves the linked structure. On the very first assembly (or after `invalidateTopology()`), elements are allocated via `allocElement` and linked; on subsequent NR iterations, `stampElement` mutates in place with no chain walks.

  ngspice reference: `spGetElement` (spbuild.c) — returns a pointer used by `*ElementPtr += value` for O(1) subsequent stamps.

- **Files to modify**:
  - `src/solver/analog/sparse-solver.ts` — Remove `_cooRows`, `_cooCols`, `_cooVals`, `_cooCount`, `_cooToCsc`, `_prevCooCount`, `_bldColCount`, `_bldColPos`, `_bldBucketRows`, `_bldBucketCooIdx` fields. Remove `_growCOO()`, `_buildCSC()`, `_refillCSC()`, `_buildLinkedMatrix()` methods. Add `allocElement(row, col): number` and `stampElement(handle, value): void`. Rewrite `beginAssembly()` to zero A-entry element values and remove fill-in entries via chain walk. Rewrite `finalize()` to compute Markowitz counts from the persistent linked structure (no CSC build).
  - The value-addressed `stamp(row, col, value)` method IS the new handle-based path internally — its signature is preserved so existing callers (MNAAssembler, ~65 element implementations) continue to work while Phase 6 migrates them to `allocElement` + `stampElement`. It is not a shim or deferral: it calls `allocElement` then `stampElement` and has no banned-phrase documentation. Deletion is a Phase 6.3 acceptance criterion once every element has been rewritten to the `load()` interface and no longer needs a value-addressed entry point.

- **Tests**:
  - `src/solver/analog/__tests__/sparse-solver.test.ts::allocElement_returns_stable_handle` — assert that calling `allocElement(r, c)` twice returns the same handle for the same (r, c), and calling with different (r, c) returns distinct handles.
  - `src/solver/analog/__tests__/sparse-solver.test.ts::stampElement_accumulates_via_handle` — assert that two `stampElement(h, v1)` + `stampElement(h, v2)` calls produce an element with summed value `v1 + v2`.
  - `src/solver/analog/__tests__/sparse-solver.test.ts::stamp_inserts_into_linked_structure` — assert that after `beginAssembly` + 4 `allocElement`+`stampElement` cycles on a 2x2 matrix + `finalize`, the linked structure has 4 elements with correct row/col/value, accessible via `_rowHead`/`_colHead` chains.
  - `src/solver/analog/__tests__/sparse-solver.test.ts::beginAssembly_zeros_values_preserves_structure` — assert that after a full solve cycle, calling `beginAssembly` again zeros all element values and RHS but linked chains remain intact (A-element count unchanged).
  - `src/solver/analog/__tests__/sparse-solver.test.ts::invalidateTopology_forces_rebuild` — assert that after `invalidateTopology()`, the next assembly clears and rebuilds the linked structure from scratch.

- **Acceptance criteria**:
  - No COO arrays exist in the codebase.
  - `stampElement()` is **strict O(1)** in the hot path — no chain walks, no lookups, pure `_elVal[handle] += value`.
  - `beginAssembly()` performs zero allocations — only zeros values via chain traversal and frees fill-in entries to the pool free-list.
  - All existing sparse-solver tests pass with the new handle-based API.

### Task 0.1.2: Drop AMD ordering — Markowitz on original column order; rename `_symbolicLU` → `_allocateWorkspace`

- **Description**: Remove `_computeAMD()`, `_buildEtree()` methods and `_perm`/`_permInv` permutation arrays. Markowitz pivot selection operates directly on the original matrix column order (after preorder), matching ngspice's `spOrderAndFactor`. The elimination order is determined solely by Markowitz pivot choice (`_pinv`/`_q`), not by a pre-computed fill-reducing permutation.

  `_symbolicLU()` is **renamed to `_allocateWorkspace()`** rather than deleted, because it performs two responsibilities: (1) AMD-dependent `_buildEtree` call (to delete), and (2) workspace array allocation for `_x`, `_xNzIdx`, `_reachStack`, `_dfsStack`, `_dfsChildPtr`, `_reachMark`, `_pinv`, `_q`, `_scratch`, `_lColPtr`/`_lRowIdx`/`_lVals`, `_uColPtr`/`_uRowIdx`/`_uVals`, and the element pool (to keep). `factorWithReorder()` calls `_allocateWorkspace()` on first reorder or after `invalidateTopology()`.

  ngspice reference: spfactor.c `spOrderAndFactor` — no AMD, no pre-permutation. Column `k` of the original matrix is processed at step `k`. Pivot selection chooses which row to pivot at each step.

- **Files to modify**:
  - `src/solver/analog/sparse-solver.ts` — Delete `_computeAMD()`, `_buildEtree()`, `_perm`/`_permInv` fields. Rename `_symbolicLU()` → `_allocateWorkspace()`; remove the `_buildEtree()` call and any AMD-permuted logic from within it, retaining the workspace array sizing/initialization. Update `_numericLUMarkowitz()` to operate in original column order (remove all `perm[k]`/`permInv[row]` indirections). Update `_numericLUReusePivots()` similarly. Update `solve()` to use only pivot permutation `_pinv`/`_q` (remove AMD permutation steps 1 and 5). Update `factorWithReorder()` to call `_allocateWorkspace()` instead of `_symbolicLU()`.
  - `src/solver/analog/__tests__/sparse-solver.test.ts` — Update all tests that reference AMD permutation behavior. Tests should verify solve correctness without AMD.

- **Tests**:
  - `src/solver/analog/__tests__/sparse-solver.test.ts::solve_without_amd_3x3` — assert that a 3x3 system Ax=b solves correctly using only Markowitz pivot ordering (no AMD permutation).
  - `src/solver/analog/__tests__/sparse-solver.test.ts::solve_without_amd_voltage_source_branch` — assert that a circuit with voltage source branch equations (off-diagonal ±1 entries) solves correctly. This exercises preorder + Markowitz without AMD.
  - `src/solver/analog/__tests__/sparse-solver.test.ts::markowitz_fill_in_without_amd` — assert that Markowitz pivot selection produces correct L/U factors for a 5x5 matrix known to generate fill-in, with results matching a reference solution.

- **Acceptance criteria**:
  - No `_perm`/`_permInv` arrays exist. No `_computeAMD`, `_buildEtree`, `_symbolicLU` methods exist.
  - `solve()` applies only pivot permutation (`_pinv`/`_q`), not AMD.
  - All circuit-level tests (MNA end-to-end, DC-OP, transient) pass with identical numerical results.

### Task 0.1.3: Build CSC from persistent linked L/U structure for solve only

- **Description**: `_numericLUMarkowitz()` inserts L and U fill-in entries into the **same persistent linked pool** as the A-matrix (see Overview). Each L or U entry stores its index into the CSC `_lVals`/`_uVals` arrays via `lValueIndex`/`uValueIndex` fields on the pool element. After `factorWithReorder()` completes, `_buildCSCFromLinked()` walks the pool once, reading `_elVal` into the CSC arrays using the stored indices — producing cache-optimal CSC L/U for forward/backward substitution.

  For `factorNumerical()` (the hot path): reuse the L/U sparsity pattern from the last reorder. `_numericLUReusePivots()` scatters current numeric values from linked pool elements into existing CSC L/U arrays via O(1) index lookup (`_lVals[elem.lValueIndex] = elem.value`). No linked-list rebuild, no pivot search.

- **Files to modify**:
  - `src/solver/analog/sparse-solver.ts` — Add `_lValueIndex: Int32Array` and `_uValueIndex: Int32Array` parallel arrays on the element pool (length = pool capacity, value `-1` for A-matrix-only entries). Add `_buildCSCFromLinked()` method called at the end of `_numericLUMarkowitz()` to snapshot linked L/U into CSC using the stored indices. Modify `_numericLUReusePivots()` to scatter values via O(1) index (no linked-structure operations). Keep `solve()` unchanged (already operates on CSC L/U).

- **Tests**:
  - `src/solver/analog/__tests__/sparse-solver.test.ts::csc_solve_matches_linked_factor` — assert that solve results after CSC build from linked structure match direct computation for a 4x4 test matrix.
  - `src/solver/analog/__tests__/sparse-solver.test.ts::numeric_refactor_reuses_csc_pattern` — assert that `factorNumerical()` after `factorWithReorder()` produces correct results using the same CSC sparsity pattern with different numeric values.

- **Acceptance criteria**:
  - `solve()` operates on CSC L/U arrays (cache-optimal forward/backward sub).
  - CSC is rebuilt only on reorder events, not every NR iteration.
  - `factorNumerical()` touches zero linked-list operations — values are scattered from linked elements into existing CSC positions.

## Wave 0.2: Real Preorder (SMPpreOrder)

### Task 0.2.1: Implement SMPpreOrder on persistent linked lists

- **Description**: Replace the no-op `preorder()` with the real ngspice `SMPpreOrder` algorithm (sputils.c:177-301). Operates on the persistent linked-list matrix structure. Finds symmetric twin pairs (entries at (J,R) and (R,J) with |value|=1.0) where the diagonal at column J is zero, and swaps columns J and R. Iterates until no more zero-diagonal columns can be fixed.

  The algorithm is detailed in master plan Appendix C (`spec/ngspice-alignment-master.md`). Key operations on linked lists:
  - Walk column J via `_colHead[J]` chain to find entries with |value|=1.0
  - For each such entry at row R, check column R for a symmetric partner at row J with |value|=1.0
  - If found (a "twin"): swap `_colHead[J]` ↔ `_colHead[R]`, update all elements' column indices, update `_diag[J]`/`_diag[R]`

  Called once, gated by `_didPreorder` flag. Must run after the first `finalize()` populates the linked structure but before the first `factor()`.

- **Files to modify**:
  - `src/solver/analog/sparse-solver.ts` — Rewrite `preorder()` method (currently lines 373-376). Add `_countTwins(col)` and `_swapColumns(col1, col2)` private helper methods.

- **Tests**:
  - `src/solver/analog/__tests__/sparse-solver.test.ts::preorder_fixes_zero_diagonal_from_voltage_source` — Build a 3x3 MNA matrix for a voltage source (structural zeros on diagonal from branch equations: row has [0, 0, 1] and another row has [0, 0, -1] pattern). Assert that after `preorder()`, the diagonal is non-zero at all positions. Assert `solve()` produces correct result.
  - `src/solver/analog/__tests__/sparse-solver.test.ts::preorder_handles_multiple_twins` — Build a 5x5 matrix with two voltage sources (two zero diagonals). Assert both are fixed by preorder.
  - `src/solver/analog/__tests__/sparse-solver.test.ts::preorder_is_idempotent` — Assert that calling `preorder()` twice produces the same result as calling it once.
  - `src/solver/analog/__tests__/sparse-solver.test.ts::preorder_no_swap_when_diagonal_nonzero` — Assert that preorder is a no-op for matrices with all-nonzero diagonals.

- **Acceptance criteria**:
  - `preorder()` fixes all structurally-zero diagonals that can be resolved by column swaps.
  - Matches ngspice `SMPpreOrder` behavior for all MNA matrices with voltage source / inductor branch equations.
  - Called once per solver lifetime (gated by `_didPreorder` flag, reset by `invalidateTopology()`).

## Wave 0.3: NISHOULDREORDER Lifecycle and E_SINGULAR Recovery

### Task 0.3.1: Explicit forceReorder() at ngspice-matching points

- **Description**: Remove all auto-detection of reorder need (topology-change-driven `_needsReorder`). The `forceReorder()` method is the sole trigger, called at exactly the points ngspice sets `NISHOULDREORDER`:
  1. On `MODEINITJCT` entry (niiter.c:856-858)
  2. On `MODEINITTRAN` when `iterno <= 1` (niiter.c:1073)
  3. After E_SINGULAR recovery (niiter.c:888-891)

  The `invalidateTopology()` method remains for genuine topology changes (new circuit via fresh solver instance), but no longer auto-sets `_needsReorder` based on COO count changes (COO no longer exists).

- **Files to modify**:
  - `src/solver/analog/sparse-solver.ts` — Remove `_topologyDirty` flag and `_prevCooCount` tracking. `factor()` dispatches solely on `_needsReorder || !_hasPivotOrder`. `finalize()` no longer touches `_topologyDirty`.
  - `src/solver/analog/newton-raphson.ts` — `forceReorder()` is called inside the `initJct`→`initFix` transition branch and inside the `initTran` branch of the NR mode-transition logic at the bottom of the iteration loop. Verify these calls match ngspice niiter.c exactly. No additional calls needed.

- **Tests**:
  - `src/solver/analog/__tests__/sparse-solver.test.ts::factor_uses_numeric_path_without_forceReorder` — Assert that after one successful `factorWithReorder`, subsequent `factor()` calls use `factorNumerical` (verify via `lastFactorUsedReorder === false`).
  - `src/solver/analog/__tests__/sparse-solver.test.ts::forceReorder_triggers_full_pivot_search` — Assert that after `forceReorder()`, the next `factor()` call uses `factorWithReorder` (verify via `lastFactorUsedReorder === true`).
  - `src/solver/analog/__tests__/newton-raphson.test.ts::forceReorder_called_on_initJct_to_initFix` — Run NR with a DC-OP circuit. After the `initJct`→`initFix` transition, assert the next `factor()` call has `solver.lastFactorUsedReorder === true`, confirming `forceReorder()` was invoked on the transition.
  - `src/solver/analog/__tests__/newton-raphson.test.ts::forceReorder_called_on_initTran_first_iteration` — Run transient with `iteration <= 1`. Assert the first `factor()` call after entering `initTran` has `solver.lastFactorUsedReorder === true`.
  - `src/solver/analog/__tests__/newton-raphson.test.ts::e_singular_recovery_reloads_and_refactors` — Build a matrix that produces E_SINGULAR on the numeric-only path. After the NR loop completes, assert (a) final solution is correct and (b) `solver.lastFactorUsedReorder === true` on the recovery iteration — this confirms the NR loop re-executed the load sequence and factored with reorder after the singular failure, without depending on whether the load function is named `stampAll` (Phase 0) or `cktLoad` (Phase 2).

- **Acceptance criteria**:
  - No auto-detection of reorder need exists. `forceReorder()` is the sole trigger.
  - E_SINGULAR recovery in newton-raphson.ts uses `continue` to restart from CKTload (Step A), not just retry factor.

### Task 0.3.2: E_SINGULAR recovery re-loads then re-factors

- **Description**: When `factor()` returns `success: false` and the last factor did NOT use reorder (`lastFactorUsedReorder === false`), the NR loop must:
  1. Call `solver.forceReorder()`
  2. `continue` back to the top of the NR for-loop (Step A: clear noncon, Step B: re-execute the load sequence — `stampAll` in Phase 0, replaced by `cktLoad` in Phase 2)

  This matches ngspice niiter.c:888-891 where E_SINGULAR sets `NISHOULDREORDER` and does `continue` (returns to top of `for(;;)`, re-executes CKTload).

  Currently we call `forceReorder()` then immediately retry `factor()` without re-loading. This is wrong — the matrix must be re-assembled with fresh device stamps before re-factoring.

- **Files to modify**:
  - `src/solver/analog/newton-raphson.ts` — Restructure E_SINGULAR handling. Replace the immediate retry with `continue` to the top of the NR loop.

- **Tests**:
  - `src/solver/analog/__tests__/newton-raphson.test.ts::e_singular_recovers_via_continue` — Create a mock circuit where `factor()` fails on the numeric-only path but succeeds after re-load + reorder. Assert the NR loop reaches convergence with the correct solution, and that `solver.lastFactorUsedReorder === true` on the recovery iteration. This verifies the observable effect (re-load + re-factor with reorder succeeded) without coupling to a specific load function name, so the test is stable across the Phase 2 `stampAll` → `cktLoad` transition.

- **Acceptance criteria**:
  - On E_SINGULAR, the NR loop re-executes the full load sequence before re-factoring.
  - Matches ngspice niiter.c:888-891 control flow exactly.
