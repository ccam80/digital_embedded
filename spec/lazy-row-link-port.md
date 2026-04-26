# Lazy Row-Link Port

Status: draft (proposed)
Owner: <unassigned>
Reference: ngspice `sparse/spbuild.c`, `sparse/spfactor.c`, `sparse/sputils.c`
Affects: `src/solver/analog/sparse-solver.ts`

## Background

The Markowitz pivoting port (commits `batch-pivmp-w1..w3` and forerunners) replaced the symbolic-CSC LU pipeline with an in-place ngspice-style elimination on the persistent linked structure. After the rewrite every numerical parity test regressed — most starkly the resistive divider, which produced `voltages = [5, 0, 0]` instead of the analytical `[5, 2.5, -0.0025]`.

Two bugs were found and patched:

1. `solve()` reading `elVal[-1] → undefined → NaN` when a fill-in landed at a future-pivot diagonal slot. Patched in `_createFillin` by setting `_diag[col] = fe` when `row === col`.
2. `solve()` back-substitution silently leaving `b[k]` un-updated because `_swapColumns` (the preorder swap) updated column structure and `_elCol[e]` but left row chains in pre-swap insertion order — so `elNextInRow[_diag[k]]` traversed elements in stale column order, often missing or reordering U entries. Patched by adding `_linkRows()` and calling it from `preorder()` after any swap.

Both patches make the resistive-divider parity tests pass and unblock most linear-circuit comparisons. They are, however, **workarounds for a single architectural mismatch with ngspice**: digiTS builds row chains *eagerly* during element allocation, while ngspice builds them *lazily* in a single pass between preorder and first factor. The patches cope with the mismatch instead of removing it.

This spec proposes removing the mismatch and reverting the workarounds, so the implementation becomes a direct line-for-line port of ngspice's row/column linkage lifecycle.

## Architectural mismatch

### ngspice (reference)

- `MatrixFrame->RowsLinked` is a boolean flag, initialized to `NO` in `spalloc.c:173`.
- `spcCreateElement` (`spbuild.c:768-870`) has two branches:
  - `RowsLinked == YES`: insert into both column **and** row chains (post-preorder, fill-ins during factor).
  - `RowsLinked == NO`: insert into column chain only; row chain is left untouched. Comment at the top of the `else` branch: *"Matrix has not been factored yet. Thus get element rather than fill-in. Also, row pointers can be ignored."*
- Both branches set `Matrix->Diag[Row] = pElement` when `Row == Col` (`spbuild.c:797` and `spbuild.c:856`). Diag maintenance is centralized at the lowest allocation primitive.
- `SwapCols` (`sputils.c:283-301`) swaps `FirstInCol`, `IntToExtColMap`, `ExtToIntColMap`, `Diag`, `NumberOfInterchangesIsOdd`. **It does not touch row chains.** The function-level comment is explicit: *"This function swaps two columns and is applicable before the rows are linked."* SwapCols also does **not** rewrite `pElement->Col` for elements in the swapped columns — that is performed once for the entire matrix by `spcLinkRows`.
- `spcLinkRows` (`spbuild.c:907-932`) walks columns from `Size` down to `1`; for each element it (a) writes `pElement->Col = Col`, (b) splices the element at the **head** of its row's `FirstInRow` chain. Walking columns in decreasing order with head-insertion produces row chains sorted ascending by current column. Sets `RowsLinked = YES`.
- `spOrderAndFactor` (`spfactor.c:240-249`) gates the row link build on the `RowsLinked` flag: `if (!Matrix->RowsLinked) spcLinkRows(Matrix);`. Runs once per first factor (or after `spStripMatrix` clears `RowsLinked`).

The contract is therefore: row chains do not exist during assembly or preorder. They are constructed once, after preorder swaps are fully baked, before any factor walks them. SwapCols is structurally trivial because rows are not yet linked.

### digiTS (current)

- `_newElement` (`sparse-solver.ts:~1000-1020` after the `_createFillin` patch) allocates a pool element and **does not** maintain `_diag`.
- `allocElement` (`sparse-solver.ts:295-366`) calls `_newElement`, then `_insertIntoRow` and `_insertIntoCol`, *and* sets `_diag[internalCol] = newE` when `row === internalCol` (line 357). Row chains are built eagerly here.
- `_createFillin` (`sparse-solver.ts:~1017`) calls `_newElement` then `_insertIntoRow` and `_insertIntoCol`. **The current patched form additionally sets `_diag[col] = fe` when `row === col`** to compensate for `_newElement` not centralizing the diag set.
- `_swapColumns` (`sparse-solver.ts:747-768`):
  - swaps `_colHead`, `_preorderColPerm`, `_extToIntCol`, `_diag`;
  - **walks both swapped column chains and rewrites `_elCol[e] = col1/col2`** (lines 762-767) in an attempt to keep the SLOT-keyed `_elCol` invariant correct after the swap;
  - **does not** repair row chains, even though row chains were built eagerly and now reference stale columns.
- `preorder()` (`sparse-solver.ts:680-…`) runs the SwapCols loop. **The current patched form additionally calls `_linkRows()` once after any swap occurred**, which rebuilds the row chains from scratch using the post-swap column structure.
- `_linkRows()` is the new method I added — a doubly-linked port of `spcLinkRows`.

This setup has two characteristics that diverge from ngspice:

1. Row chain insertion happens twice for every element that survives a preorder swap — once at allocation, once in the rebuild. The first insertion is wasted work, and worse, it imposes a maintenance burden on every callsite that touches column structure (see `_swapColumns`'s `_elCol[e]` rewrite loop).
2. Diag maintenance is split: `allocElement` sets it, `_createFillin` sets it (after my patch), and `_newElement` doesn't. Any future caller that goes through `_newElement` directly without setting `_diag` reproduces the original NaN-in-`solve()` bug. ngspice avoided this by setting Diag inside `spcCreateElement` itself.

## Proposed clean port

### Goals

- Match ngspice's lifecycle line-for-line: assembly builds column chains only; preorder mutates column structure only; row chains are constructed once via `_linkRows` at factor entry.
- Centralize `_diag` maintenance in `_newElement` so every allocation path (regular, fill-in, future) gets it.
- Remove the workarounds: `_linkRows()` call from `preorder()`, `_diag[col] = fe` from `_createFillin`, `_elCol[e]` rewrite loop in `_swapColumns`.

### Changes

1. **Add `_rowsLinked: boolean` field**, initialized `false`. Source-of-truth for "row chains have been constructed at least once since last topology invalidation." Mirrors `Matrix->RowsLinked`.
2. **`_newElement` sets `_diag`.**
   - When `row === col`, write `this._diag[col] = e` immediately after the row/col fields are assigned.
   - Mirrors `spcCreateElement` `spbuild.c:797` (RowsLinked branch) and `spbuild.c:856` (unlinked branch).
3. **`_newElement` skips row-chain insertion when `_rowsLinked === false`.**
   - Caller responsibility: `_insertIntoRow` is invoked only when `_rowsLinked === true`. The sites that currently call `_insertIntoRow` are `allocElement` and `_createFillin`. Both need to gate the row insert on `_rowsLinked`. (Alternative: fold the row insert into `_newElement` itself and gate it there. Either is acceptable; pick one and make it consistent.)
   - Mirrors `spcCreateElement` `spbuild.c:775` (`if (Matrix->RowsLinked)`).
4. **Remove the `_diag[col] = fe` set added to `_createFillin` in the workaround patch.** The diag set now happens in `_newElement` at the same point as for non-fill-in elements.
5. **Strip `_swapColumns` down to its ngspice-equivalent body**:
   - Keep: swap of `_colHead`, `_preorderColPerm`, `_extToIntCol`, `_diag`. Match `SwapCols` `sputils.c:283-301`.
   - Remove: the `_elCol[e] = col1/col2` rewrite loop (lines 762-767). Element `_elCol` values are not authoritative until `_linkRows` runs and writes them.
   - Remove: any incidental row-chain references.
6. **Remove the `_linkRows()` call from `preorder()`.** Preorder no longer interacts with row chains in any way.
7. **Wire `_linkRows()` into the factor entry instead.**
   - At the top of `factorWithReorder`, before `_numericLUMarkowitz`, gate on `_rowsLinked`:
     ```ts
     if (!this._rowsLinked) {
       this._linkRows();
       this._rowsLinked = true;
     }
     ```
   - Mirrors `spOrderAndFactor` `spfactor.c:246-247`.
   - `_linkRows` already writes `_elRow[e]` and `_elCol[e]` to slot indices and sets up both `_elNextInRow`/`_elPrevInRow` and (for symmetry) re-emits the col-chain element identity. Verify that the existing `_linkRows` body is sufficient when called once on a matrix whose row chains have **never** been touched (i.e., `_elNextInRow`, `_elPrevInRow`, `_rowHead` start at `-1`). If the current implementation assumes any pre-existing row state, adjust to be self-contained.
8. **`invalidateTopology` resets `_rowsLinked = false`** alongside `_didPreorder` and `_needsReorder`. Mirrors `spStripMatrix` (`sputils.c:1104-1145`) clearing `RowsLinked` together with `Reordered` and setting `NeedsOrdering = YES`.
9. **`_resetForAssembly` does NOT touch `_rowsLinked`.** Between NR iterations the row chain remains valid (assembly only zeros `_elVal[e]`); ngspice spClear behaves the same way (`spbuild.c:96-142`). Confirm by reading the current `_resetForAssembly` after this change to ensure no row-state is being clobbered.

### Reversions of workaround patches

The following patches, added during the diagnosis pass, are removed by the clean port:

- **`_createFillin` `_diag[col] = fe`** (current code — added during diagnosis):
  ```ts
  if (row === col) this._diag[col] = fe;
  ```
  Reverted because `_newElement` now centralizes the diag set.

- **`_linkRows()` call site at end of `preorder()`** (current code — added during diagnosis):
  ```ts
  if (anySwap) this._linkRows();
  ```
  Reverted because the row chains do not exist at preorder time. The `anySwap` local variable that was added to `preorder()` is also removed.

- **`_elCol[e]` rewrite loop in `_swapColumns`** (the per-call loop walking the two swapped columns to overwrite `_elCol[e]`):
  ```ts
  let e = this._colHead[col1];
  while (e >= 0) { this._elCol[e] = col1; e = this._elNextInCol[e]; }
  e = this._colHead[col2];
  while (e >= 0) { this._elCol[e] = col2; e = this._elNextInCol[e]; }
  ```
  Reverted because `_linkRows` now writes `_elCol[e]` for every element in the matrix when it runs at factor entry. This also matches ngspice's SwapCols, which never updates `pElement->Col`.

The `_linkRows()` method itself is **kept** — it is the direct port of `spcLinkRows`. Only its call site moves from `preorder()` to `factorWithReorder` (gated on `_rowsLinked`).

### Things to verify after the port

- All existing sparse-solver unit tests pass (or fail with the same pre-existing test-expectation drifts already documented: `markowitzRow.length` expected `n` but allocated `n+2`, and `singletons > 0` after factor — both unrelated).
- `resistive-divider` parity tests (DC-OP and transient) continue to pass.
- `_diag-rc-transient` continues to pass.
- The pivot-map probe scenario (3×3 with structural zero on diagonal, fill-in landing on a future-pivot diagonal slot) still produces the correct solution. This was the canary for the `_diag` bug; it must remain green after `_diag` set moves into `_newElement`.
- No new failures appear in the parity sweep beyond the existing list documented in the prior status update (1-ULP rc-transient and rlc-oscillator differences, MOSFET VBD model issue, diode-resistor NR iter count, and the 50-node sparse-solver hang — none of which this port purports to fix).

### Out of scope

- The remaining 1-ULP differences in `rc-transient` and `rlc-oscillator`. These are separate FP-ordering investigations.
- The MOSFET `VBD` divergence and the diode-resistor NR iter count divergence. Device-model and convergence-path issues, respectively.
- The 50-node sparse-solver hang. Likely a separate chain-corruption or pivot-loop bug, not addressed by this port.
- The pre-existing test-expectation drifts in `sparse-solver.test.ts` (e.g. `markowitzRow.length === n` assertion). They were stale before either workaround patch and remain stale after the clean port.

## Appendix — ngspice mapping table

| ngspice | digiTS (after clean port) |
|---|---|
| `Matrix->RowsLinked` | `this._rowsLinked` |
| `Matrix->FirstInCol` | `this._colHead` |
| `Matrix->FirstInRow` | `this._rowHead` |
| `pElement->NextInCol` | `this._elNextInCol[e]` |
| `pElement->NextInRow` | `this._elNextInRow[e]` |
| `pElement->Row` | `this._elRow[e]` |
| `pElement->Col` | `this._elCol[e]` |
| `Matrix->Diag` | `this._diag` |
| `spcCreateElement` (linked branch) | `_newElement` (when `_rowsLinked === true`, plus `_insertIntoRow`/`_insertIntoCol`) |
| `spcCreateElement` (unlinked branch) | `_newElement` (when `_rowsLinked === false`, plus `_insertIntoCol` only) |
| `SwapCols` | `_swapColumns` (clean form) |
| `spcLinkRows` | `_linkRows` |
| `spOrderAndFactor` link gate (`spfactor.c:246-247`) | `factorWithReorder` link gate (top of method) |
| `spStripMatrix` | `invalidateTopology` |

## Open questions

- Where does `_linkRows` get its element pool to walk? Currently it walks `_colHead[col]` for each column; that is correct for the lazy model because column chains are the source of truth at link time. Confirm no element exists in the pool that is not reachable from some `_colHead` chain at link time — fill-ins can only be created during factor (after link), so all elements at link time are either A-matrix entries (allocated via `allocElement`) or none. This invariant is implied by the architecture but should be asserted in `_linkRows` (debug-only check) to prevent future regressions.
- Does any existing call site iterate row chains *before* the first factor (e.g., for diagnostics, for preorder twin-pair detection, or for assembly inspection)? `preorder()` walks column chains via `_findTwin` (looks fine — column-only) and `_diag[col]` (fine — diag is set on alloc). `_countMarkowitz` walks both chains and is called from `_numericLUMarkowitz` after the proposed link gate fires (fine). Audit by searching for `_rowHead`, `_elNextInRow`, `_elPrevInRow` usages and verifying every one runs after a guaranteed `_linkRows` call.
