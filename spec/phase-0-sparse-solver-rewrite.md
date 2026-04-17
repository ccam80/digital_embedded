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

## Wave 0.4: Complex Sparse Solver Parity

Port Waves 0.1–0.3 onto `ComplexSparseSolver` so AC analysis operates on the same architecture as DC/transient. Scheduled independently of 0.1/0.2/0.3 (different file, different call sites) and can run in parallel with Phase 6.

**Design parity with the real sparse solver:**
- Persistent linked-list matrix as canonical representation — mirror of the `spMatrix` replacement from Wave 0.1, with values stored as parallel `_elRe` / `_elIm` Float64Arrays.
- Handle-based API: `allocComplexElement(row, col): number` at first stamp, `stampComplexElement(handle, re, im): void` on the hot path. No value-addressed stamp survives this wave.
- Markowitz pivot selection on original column order. No AMD, no etree.
- Real `SMPpreOrder` operating on the complex linked-list structure to fix zero-diagonal columns from voltage-source / inductor branch rows. Magnitude test uses `re*re + im*im === 1.0` to match ngspice's `|value| === 1.0` check.
- Explicit `forceReorder()` lifecycle — called once by `AcAnalysis.run()` before the first frequency's factor; subsequent frequencies use the numeric-only refactor path.

**Hot-path symmetry:** `element.stampAc(solver, omega)` runs once per element per frequency point. Elements cache complex handles on the first frequency's call to `allocComplexElement` and reuse them for every subsequent frequency, analogous to how `load()` callers cache real handles across NR iterations. Per-frequency stamps are strict O(1) `stampComplexElement(handle, re, im)` with no pattern rebuild.

**Bit-exactness target:** Per-frequency node voltages match ngspice `.AC` output with `absDelta === 0` on both real and imaginary parts — same IEEE-754 bar applied to DC/transient in Phase 7.

### Task 0.4.1: Replace COO with persistent linked-list complex matrix and handle-based stamp API

- **Description**: Remove the COO triplet arrays (`_cooRows`, `_cooCols`, `_cooRe`, `_cooIm`, `_cooCount`) and the `_growCOO()`, `_buildCSC()`, `_patternChanged()` methods. Add a persistent linked-list element pool with parallel `_elRow: Int32Array`, `_elCol: Int32Array`, `_elRe: Float64Array`, `_elIm: Float64Array`, `_colHead: Int32Array`, `_rowHead: Int32Array`, `_elNextInRow: Int32Array`, `_elNextInCol: Int32Array`, `_diag: Int32Array` — the complex analogue of the Wave 0.1 pool.

  New API:
  - `allocComplexElement(row: number, col: number): number` — returns a stable handle (pool index). On the first allocation at (row, col) creates and links a new pool entry; subsequent calls for the same (row, col) return the cached handle.
  - `stampComplexElement(handle: number, re: number, im: number): void` — O(1) accumulate: `_elRe[handle] += re; _elIm[handle] += im`.

  `beginAssembly(n)` zeros `_elRe[h]` and `_elIm[h]` for every handle via chain walk, frees fill-in entries to a pool free-list, and leaves the linked structure intact. `finalize()` computes Markowitz counts from the linked structure directly — no CSC build at this point.

  ngspice reference: spbuild.c `spGetElement` — complex variant uses the same cached-pointer pattern as the real-valued case, only the value type differs.

- **Files to modify**:
  - `src/solver/analog/complex-sparse-solver.ts` — Replace COO fields with linked-list pool fields. Replace the bodies of `beginAssembly()`, `finalize()`, and the stamp API. The value-addressed `stamp(row, col, re, im)` method stays as a thin wrapper (calls `allocComplexElement` then `stampComplexElement`) only until Task 0.4.4 performs the atomic deletion — analogous to how Wave 6.3 Task 6.3.4 deletes the real-side `stamp()` after Wave 6.2 migrates callers.
  - `src/core/analog-types.ts` — Add `allocComplexElement(row, col): number` and `stampComplexElement(handle, re, im): void` to the `ComplexSparseSolver` interface.

- **Tests**:
  - `src/solver/analog/__tests__/complex-sparse-solver.test.ts::allocComplexElement_returns_stable_handle` — two calls with the same (row, col) return the same handle; distinct (row, col) pairs return distinct handles.
  - `src/solver/analog/__tests__/complex-sparse-solver.test.ts::stampComplexElement_accumulates_both_parts` — after `stampComplexElement(h, 1, 2)` then `stampComplexElement(h, 3, -4)`, the element at handle h has `re === 4` and `im === -2`.
  - `src/solver/analog/__tests__/complex-sparse-solver.test.ts::stampComplexElement_inserts_into_linked_structure` — 2×2 matrix; after 4 `allocComplexElement` + `stampComplexElement` cycles + `finalize`, linked structure has 4 elements with correct row / col / re / im accessible via `_rowHead` / `_colHead` chains.
  - `src/solver/analog/__tests__/complex-sparse-solver.test.ts::beginAssembly_zeros_complex_values_preserves_structure` — after a full solve cycle, another `beginAssembly(n)` zeros all element `_elRe` / `_elIm` and RHS while leaving the linked chains intact (element count unchanged).
  - `src/solver/analog/__tests__/complex-sparse-solver.test.ts::invalidateTopology_forces_complex_rebuild` — after `invalidateTopology()`, the next assembly clears and rebuilds the linked structure from scratch.

- **Acceptance criteria**:
  - No COO arrays, no `_growCOO`, no `_buildCSC`, no `_patternChanged` in `complex-sparse-solver.ts`.
  - `stampComplexElement()` is strict O(1) in the hot path — no chain walks, pure `_elRe[h] += re; _elIm[h] += im`.
  - `beginAssembly()` performs zero allocations — only chain-walk value zeroing and free-list pushes.

### Task 0.4.2: Drop AMD and etree — Markowitz on original column order

- **Description**: Delete `_computeAMD()`, `_buildEtree()`, and the `_perm` / `_permInv` fields. Markowitz pivot selection operates on the original (preordered) column order, matching ngspice `spOrderAndFactor`. Rename `_symbolicLU()` → `_allocateComplexWorkspace()`, removing the `_buildEtree()` call from within and retaining only its workspace-sizing responsibility: `_xRe`, `_xIm`, `_xNzIdx`, `_reachStack`, `_dfsStack`, `_dfsChildPtr`, `_reachMark`, `_pinv`, `_q`, `_scratchRe`, `_scratchIm`, and the L/U CSC arrays.

  `_numericLU()` iterates columns `k = 0..n-1` on the original matrix — replace `perm[k]` indirections with `k` and remove `permInv[row]` indirections. `solve()` removes Step 1 (AMD permute RHS) and Step 5 (undo AMD); retains pivot permutation via `_pinv` / `_q` only.

  ngspice reference: spfactor.c `spOrderAndFactor` — identical for complex and real matrices apart from the value type.

- **Files to modify**:
  - `src/solver/analog/complex-sparse-solver.ts` — Delete `_computeAMD()`, `_buildEtree()`, `_perm`, `_permInv` fields. Rename `_symbolicLU()` → `_allocateComplexWorkspace()` and remove the etree call. Update `_numericLU()` and `solve()` per the above.

- **Tests**:
  - `src/solver/analog/__tests__/complex-sparse-solver.test.ts::solve_without_amd_3x3_complex` — 3×3 complex system Ax=b solves correctly using only Markowitz pivot ordering.
  - `src/solver/analog/__tests__/complex-sparse-solver.test.ts::solve_complex_voltage_source_branch` — complex MNA matrix with an off-diagonal ±1 branch structure solves correctly after preorder + Markowitz without AMD.
  - `src/solver/analog/__tests__/complex-sparse-solver.test.ts::markowitz_complex_fill_in_without_amd` — 5×5 complex matrix known to generate fill-in produces factors matching an independently-computed reference.

- **Acceptance criteria**:
  - No `_perm`, `_permInv`, `_computeAMD`, `_buildEtree`, or `_symbolicLU` names exist in `complex-sparse-solver.ts`.
  - `solve()` applies only pivot permutation (`_pinv` / `_q`).
  - Existing `ac-analysis` unit tests pass.

### Task 0.4.3: Implement SMPpreOrder on the complex linked structure

- **Description**: Port the real-side Wave 0.2 preorder onto the complex linked-list matrix. Twin detection uses `re*re + im*im === 1.0` to match ngspice's `|value| === 1.0` check on AC branch-row entries from voltage sources and inductors. Called once per solver lifetime, gated by `_didPreorderComplex` flag, reset by `invalidateTopology()`.

  Structurally follows master plan Appendix C adapted to complex values: walk column J via `_colHead[J]` looking for an entry at row R with `re² + im² === 1`; if found, check column R for a symmetric partner at row J with `re² + im² === 1`; on success, swap columns J and R via the same O(1) SwapCols equivalent implemented for the real side (see `progress.md` Task phase0-v03-v04-swapcols).

  Must run after the first `finalize()` populates the linked structure but before the first `factor()`.

- **Files to modify**:
  - `src/solver/analog/complex-sparse-solver.ts` — Add `preorder()` public method. Add `_findComplexTwin(col): number` and `_swapComplexColumns(col1, col2, pTwin1, pTwin2)` private helpers. Add `_preorderComplexColPerm: Int32Array` and `_extToIntComplexCol: Int32Array` fields — mirror of the real-side pair. `solve()` applies `_preorderComplexColPerm` to map internal solution indices back to original variable indices, same as the real side.

- **Tests**:
  - `src/solver/analog/__tests__/complex-sparse-solver.test.ts::preorder_fixes_zero_diagonal_from_ac_voltage_source` — 3×3 AC MNA matrix with a voltage-source branch row (structural zero on the diagonal). After `preorder()`, diagonal is nonzero everywhere; `solve()` produces the correct complex solution.
  - `src/solver/analog/__tests__/complex-sparse-solver.test.ts::preorder_handles_multiple_complex_twins` — 5×5 complex system with two voltage sources; both zero diagonals fixed.
  - `src/solver/analog/__tests__/complex-sparse-solver.test.ts::preorder_idempotent_complex` — two sequential `preorder()` calls produce identical internal state and identical `solve()` output.
  - `src/solver/analog/__tests__/complex-sparse-solver.test.ts::preorder_complex_no_swap_when_diagonal_nonzero` — full-diagonal complex matrix unchanged by preorder.
  - `src/solver/analog/__tests__/complex-sparse-solver.test.ts::complex_elCol_preserved_after_preorder_swap` — after a swap actually occurs, every element's `_elCol[e]` and `_elRow[e]` equal their pre-preorder values, and solve still satisfies A*x = b to IEEE-754 precision. Mirrors the real-side V-03/V-04 remediation test.

- **Acceptance criteria**:
  - `preorder()` fixes every zero-diagonal column resolvable by twin swaps.
  - Magnitude check uses exact `re*re + im*im === 1.0`.
  - Called once per solver lifetime; gated by `_didPreorderComplex` flag.

### Task 0.4.4: Delete value-addressed `stamp(row, col, re, im)` and migrate all stampAc implementations

- **Description**: Atomic deletion gate for Wave 0.4. Every `stampAc(solver, omega)` implementation in the codebase migrates to cache complex handles on its first call and use `stampComplexElement(handle, re, im)` thereafter. Mirror of Phase 6 Wave 6.3 Task 6.3.4 for the real side.

  Handle-caching pattern: on the first frequency, the element calls `solver.allocComplexElement(row, col)` once per stamp location and stores the result in a dedicated `_acHandles: Int32Array` field (or similar) allocated at first call. Subsequent frequencies call `stampComplexElement(handle, re, im)` directly.

  Because AC is driven by `AcAnalysis.run()` rather than an NR loop, the handle cache is invalidated on `solver.invalidateTopology()` calls — same contract as the real-side cache.

- **Files to modify**:
  - `src/solver/analog/complex-sparse-solver.ts` — Delete the `stamp(row: number, col: number, re: number, im: number): void` method.
  - `src/core/analog-types.ts` — Remove `stamp(row, col, re, im)` from the `ComplexSparseSolver` interface. `stampRHS(row, re, im)` is retained unchanged.
  - Every element implementing `stampAc` — migrate to the handle-based API. Non-exhaustive list (the atomic gate is that full-codebase `tsc --noEmit` must succeed after Wave 0.4 lands):
    - `src/components/passives/resistor.ts`, `capacitor.ts`, `polarized-cap.ts`, `inductor.ts`, `transformer.ts`, `tapped-transformer.ts`
    - `src/components/semiconductors/diode.ts`, `bjt.ts`, `mosfet.ts`, `njfet.ts`, `pjfet.ts`, `zener.ts`, `tunnel-diode.ts`, `varactor.ts`, `triode.ts`
    - `src/components/active/opamp.ts`, `real-opamp.ts`, `comparator.ts`, `ota.ts`, `vcvs.ts`, `vccs.ts`, `ccvs.ts`, `cccs.ts`
    - `src/components/sources/dc-voltage-source.ts`, `ac-voltage-source.ts`, `current-source.ts`, `variable-rail.ts`
    - `src/solver/analog/digital-pin-model.ts` — any `stampAc` path, if exposed, migrates to the handle-based API alongside Phase 6 Wave 6.4's load() rewrite.
    - Any additional file that grep for `stampAc` surfaces across `src/`.

- **Tests**:
  - `src/solver/analog/__tests__/complex-sparse-solver.test.ts::value_addressed_stamp_deleted` — `(new ComplexSparseSolver() as any).stamp === undefined`.
  - `src/solver/analog/__tests__/ac-analysis.test.ts::ac_sweep_reuses_handles_across_frequencies` — a 3-point sweep with a single resistor element; spy on `solver.allocComplexElement` and assert it is called exactly twice (once per stamp location on the first frequency) and zero times on subsequent frequencies.
  - Existing `src/solver/analog/__tests__/ac-analysis.test.ts` assertions continue to pass bit-exact.

- **Acceptance criteria**:
  - `ComplexSparseSolver.stamp(row, col, re, im)` does not exist.
  - Zero grep hits for `.stamp(` on a `ComplexSparseSolver` instance anywhere in `src/` or test fixtures.
  - Every `stampAc` implementation caches complex handles on first call.
  - Full-codebase `tsc --noEmit` succeeds after this task lands — Wave 0.4 is the atomic gate for complex-side migration, independent of Phase 6's atomic gate for real-side.

### Task 0.4.5: Explicit forceReorder() on AC sweep entry

- **Description**: Add a public `forceReorder()` method on `ComplexSparseSolver` mirroring the real-side Wave 0.3 implementation. `AcAnalysis.run()` calls `solver.forceReorder()` once before the first frequency's `finalize()` / `factor()`. Subsequent frequencies reuse the pivot ordering and CSC sparsity pattern — only values change — so `factor()` dispatches to the numeric-only refactor path, matching the real-side `factorNumerical` hot path.

  Remove any auto-detection of reorder need based on topology-change flags; `forceReorder()` + `invalidateTopology()` are the sole triggers.

- **Files to modify**:
  - `src/solver/analog/complex-sparse-solver.ts` — Add public `forceReorder()` method (sets `_needsReorderComplex = true`). Add public `lastFactorUsedReorder: boolean` accessor. `factor()` dispatches on `_needsReorderComplex || !_hasComplexPivotOrder` to the full-reorder path; otherwise to numeric-only refactor with the existing pivot pattern. Remove `_topologyDirty` auto-detection based on CSC-pattern deep comparison.
  - `src/solver/analog/ac-analysis.ts` — After the first frequency's `beginAssembly(N_ac)` and element stamps, call `solver.forceReorder()` exactly once; frequencies 2..N skip the call.

- **Tests**:
  - `src/solver/analog/__tests__/complex-sparse-solver.test.ts::factor_uses_numeric_path_after_first_complex_reorder` — after one successful `factor()` with reorder, subsequent `factor()` calls set `lastFactorUsedReorder === false`.
  - `src/solver/analog/__tests__/complex-sparse-solver.test.ts::forceReorder_triggers_full_complex_pivot_search` — after `forceReorder()`, the next `factor()` sets `lastFactorUsedReorder === true`.
  - `src/solver/analog/__tests__/ac-analysis.test.ts::ac_sweep_single_reorder_across_frequencies` — 5-point AC sweep; assert `solver.lastFactorUsedReorder === true` on frequency 1 and `false` on frequencies 2–5.

- **Acceptance criteria**:
  - `forceReorder()` is the sole trigger for full reorder on the complex side (no CSC-pattern auto-detection).
  - `AcAnalysis.run()` calls it exactly once per sweep.
  - Numeric-only refactor is used for every frequency after the first.
