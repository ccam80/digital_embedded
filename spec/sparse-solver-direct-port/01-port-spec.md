# Sparse Solver Direct Port — Implementation Spec

**Subject:** convert `src/solver/analog/sparse-solver.ts` into a direct
line-for-line port of ngspice's sparse module (`ref/ngspice/src/maths/sparse/`).

**Status:** draft for user dispatch
**Companion:** `spec/sparse-solver-direct-port/00-structural-review.md`
**Project rule (CLAUDE.md):**

> When implementing or fixing any SPICE-derived algorithm … match the
> corresponding ngspice source function exactly … 30 years of SPICE
> experience and painstaking development. Equality or nothing.

---

## Patch History

User review of the v1 spec identified 8 gaps between this spec and the
structural review. v2 patches each one — audit trail below; spec-internal
detail in the cited stages.

- **Gap 1 — `_elFlags` / `FLAG_FILL_IN`:** added to **Stage 4** (delete dead workspace), with a Stage 5 sequencing note that the `FLAG_FILL_IN` reads inside `finalize()` must be gone first.
- **Gap 2 — `Error` / `SingularRow` / `SingularCol`:** new sub-stage **6A** restores the ngspice error/singularity write sites; `FactorResult` extended; downstream consumer wiring deferred to a follow-up spec (callers named).
- **Gap 3 — RHS zeroing in `beginAssembly` line 422:** added explicit edit row to **Stage 4A** (`beginAssembly` restructure) deleting the RHS-zero loop. Per banned-pattern guard rule #9.
- **Gap 4 — `solve()` `if (n === 0) return` early-exit:** added explicit edit row to new sub-stage **Stage 6B** deleting the guard. Per banned-pattern guard rule #1.
- **Gap 5 — `_resetForAssembly` chain walk:** new dedicated sub-stage **Stage 5A** converts the body to the ngspice `spClear` chain walk. Mandatory.
- **Gap 6 — `invalidateTopology` cleanup:** new sub-stage **Stage 4C** enumerates every field `spStripMatrix` clears.
- **Gap 7 — `Elements` / `Originals` / `Fillins` counters:** new sub-stage **Stage 4B** introduces the three instance fields and wires the increments at the same sites ngspice does.
- **Gap 8 — `beginAssembly` ngspice home:** investigated three candidates (`spClear`, `spcCreateInternalVectors`, `SMPpreOrder`); the steady-state body maps to `SMPclear` -> `spClear`, the first-call alloc maps to `spCreate` + `spcCreateInternalVectors`. New sub-stage **Stage 4A** restructures `beginAssembly` to mirror that. **No `architectural-alignment.md` escalation needed.**
- **Stage 1 inter-stage dependency:** `_linkRows` must write `_elCol[e]` to mirror `spcLinkRows` at `spbuild.c:923`. Discovered when tests hung after first Stage 1 application.

---

## Banned-Pattern Guard (read this first)

This is a port, not a re-implementation. If your hand reaches for any of
these, STOP and report.

1. **Do not introduce safety guards that ngspice does not have.** If
   ngspice dereferences a pointer without a NULL check, your port
   dereferences without a `>= 0` check. UB-on-bad-input is part of the
   port surface.
2. **Do not add doubly-linked prev pointers back.** Every `*PtrToPtr = X`
   in C is a singly-linked update. Translate via a `prev` local rebuilt
   per chain walk, or via a small TS helper. No `_elPrev*` arrays.
3. **Do not optimize away column-chain searches with hash maps.** No
   handle table. `allocElement` performs the column-chain walk.
4. **Do not pre-compute Markowitz outside `spOrderAndFactor`.**
   `CountMarkowitz` and `MarkowitzProducts` run from inside the port
   of `spOrderAndFactor`, gated to once per reorder. They do NOT run
   from `finalize()`.
5. **Do not reinterpret an ngspice function "more cleanly".** The C
   layout is the spec. If you would refactor it, you would also
   refactor the ngspice we are porting.
6. **Do not delete the inverted-condition pivot-search bug.** The bug at
   `spfactor.c:1116/1132/1150` is in the port. It is preserved.
7. **Do not introduce instance-field carry-overs that ngspice handles
   with local variables.** The C function-local `Step` counter inside
   `spOrderAndFactor` does not become an instance field. It is a function
   local in your port too — which means the reuse-loop and the reorder-loop
   live in the same function.
8. **Do not split `spOrderAndFactor` into multiple TS methods.** Keep
   the two consecutive loops with shared `Step` inside one method body.
9. **Do not zero RHS in `beginAssembly` or anywhere else inside the
   solver.** RHS management is the caller's responsibility per
   `niiter.c`. (Today digiTS zeros RHS at line 422; that is digiTS-only.)
10. **Do not "improve" the LU storage convention.** Post-factor `_elVal`
    holds: `_elVal[_diag[k]] = 1/pivot_k`, `_elVal[(i,k)] i<k = U_ik =
    A_ik_post / pivot_i`, `_elVal[(i,k)] i>k = L_ik = A_ik_post`. Same
    convention as ngspice.
11. **Do not delete the column-chain sorted-insert.** ngspice
    `spcCreateElement` inserts at `*LastAddr` returned by
    `spcFindElementInCol`, which performs the sorted scan. The TS port
    must do the same — pivot search routines depend on chains being
    sorted ascending by row/col.
12. **If a stage's verification gate fails, STOP and report.** Do not
    "fix" the spec, do not "fix" the ngspice. Either the spec is wrong
    or the implementation is. The port plan rolls back; it does not
    soft-pedal.

If you cannot port a section because the ngspice source uses a feature
TypeScript cannot express (e.g. raw pointer-to-pointer), STOP and
escalate with a specific TS-language reason. Do not substitute.

---

## Stage 0 — Preparation

### 0.1 Snapshot

- **Branch:** `main` at commit `6f2274e7` ("phase-instance-vs-model-param-partition: end-of-session state")
- **Working tree state:** modified `src/solver/analog/sparse-solver.ts` plus several test files. Working tree must be clean before Stage 1.
- **Currently passing parity tests (per session findings 1.2):**
  `harness-integration.test.ts` 29/29; `sparse-reset-semantics.test.ts` (new) green; `coordinator-capability` and `real-opamp` improved from 4 fail to 3 fail.
- **Currently failing tests:**
  - 1-ULP parity failures (`rc-transient`, `rlc-oscillator`, likely `diode-resistor`) — Class A
  - `opamp-inverting` step=0 iter=0 4-decade RHS gap — Class B (outside sparse-solver)
  - `mosfet-inverter` step=0 iter=0 VBD state-init disagreement — Class B (outside sparse-solver)
  - `diode-bridge` parity test "hang" (in harness, not solver) — Class C
  - `sparse-solver.test.ts` x 7 white-box tests asserting `markowitzRow.length === 3` and `_elCol_preserved_after_preorder_swap` — pre-existing
  - `ckt-context.test.ts loadCtx_fields_populated` and `dcop-init-jct.test.ts` x 3 — pre-existing, unrelated

### 0.2 Parity contract

Every numerical test currently expected to pass must remain bit-exact
against ngspice when the port is complete. The 1-ULP failures (Class A)
must reach zero ULP. **No tolerance loosening.** Tests already encode the
strict contract via `parity-helpers.ts:40` `expect(absDelta).toBe(+0)`.

The four Class B / Class C failures are out of scope for the port (each
lives outside `sparse-solver.ts`). Each will be re-evaluated in the Final
Stage; if any of them now passes after the port, that is a bonus and a
data point about which structural divergence was responsible. None should
regress.

### 0.3 Tooling — comparison instrument

The ngspice harness in `docs/ngspice-harness-howto.md` is the comparison
instrument for every stage's verification gate. Per CLAUDE.md "ngspice
Comparison Harness — First Tool for Numerical Issues", the implementer
runs the harness for each stage's failing test (if any) BEFORE attempting
fixes.

The convergence log (per CLAUDE.md) is the secondary instrument for
crashes and stagnation.

### 0.4 Out-of-scope items (explicit non-goals)

- Complex-arithmetic factor (`FactorComplexMatrix`, `ComplexRowColElimination`).
  Real-only port.
- Partition / direct-addressing scatter-gather (`spfactor.c:337, 352-410`).
  See "Escalations for user decision" in `00-structural-review.md` §F.2.
- `TrashCan` sentinel element. See §F.3 of the review.
- `spStripFills`, `spDeleteRowAndCol`, `spScale`, `spCondition`,
  `spDeterminant`, `spNorm`, `spLargestElement`, `spRoundoff`. None are
  used by digiTS's NR loop.

---

## Stage Ordering Rationale

I order by risk descent. Highest-blast-radius (lifecycle and data-structure
shape) first, so each later stage operates on a matrix that already has the
ngspice topology. The ordering is:

1. Add `_rowsLinked` flag and lazy-link the rows. Removes the workaround
   chain (`_diag[col]` set in `_createFillin`, `_elCol[e]` rewrite in
   `_swapColumns`, `_linkRows()` call in `preorder()`).
2. Delete `_elPrevInRow` / `_elPrevInCol`. Replace doubly-linked
   prev-maintenance with C-style `prev` locals.
3. Delete `_handleTable` and the dual-branch in `allocElement`. Single
   column-chain-walk path.
4. Delete `_q` / `_pinv` / `_elMark` / `_rowToElem` / `_elFlags` / `_elFreeHead` (dead workspace), then:
   - **Stage 4A** — restructure `beginAssembly` to mirror `SMPclear` -> `spClear` and remove the RHS-zero loop;
   - **Stage 4B** — introduce `_elements` / `_originals` / `_fillins` counters per `MatrixFrame`;
   - **Stage 4C** — expand `invalidateTopology` to mirror `spStripMatrix` field-by-field.
5. Move Markowitz precompute out of `finalize()` into the port of
   `spOrderAndFactor` (Hypothesis D.1.A); also:
   - **Stage 5A** — convert `_resetForAssembly` from pool-linear walk to ngspice `spClear` chain walk.
6. Collapse `factor()`/`factorWithReorder()`/`factorNumerical()`/
   `_numericLUMarkowitz()` dispatch graph into a single port of
   `spOrderAndFactor` plus a port of `spFactor` (reuse-only). Removes
   the C3-class hazard structurally. Includes:
   - **Stage 6A** — restore `_error` / `_singularRow` / `_singularCol` instance fields and writes;
   - **Stage 6B** — delete `solve()` `if (n === 0) return` early-exit guard.
7. Index-base sweep — make 1-based throughout, OR document the
   mechanical translation rule and assert it everywhere.
8. Sweep capture buffers / accessors out of the production class into a
   side instrumentation surface.
9. Final stage — bit-exact parity sweep.

---

## Stage 1 — Lazy Row-Link

### 1.0 Inter-stage dependency note (READ BEFORE EDITING)

The edits in this stage form a chain: `_swapColumns` -> `_linkRows` ->
`_countMarkowitz`. Specifically, edit 1.3.7 removes `_swapColumns`'s
`_elCol[e]` rewrite (correctly mirroring `SwapCols` at `sputils.c:283-301`
which does not touch element fields). The post-condition is that
`_elCol[e]` becomes stale for every element on a swapped column.

ngspice resolves this in `spcLinkRows` (`spbuild.c:907-932`): the inner
walk at `spbuild.c:923` writes `pElement->Col = Col;` for every element
it sees, refreshing every `Col` field. digiTS's existing `_linkRows`
was written by the prior lazy-link-port author as a workaround that
left the `_elCol[e]` write in `_swapColumns`; if Stage 1 removes the
`_swapColumns` write WITHOUT also adding the `_linkRows` write, every
element on a swapped column ends up with stale `_elCol[e]`. The
downstream effect is `_countMarkowitz` reading the wrong column for
those elements -> bad pivot decisions -> likely hang via runaway
reorder oscillation.

**Lesson:** edits 1.3.7 and 1.3.11 are not independent. Apply them
together in the same commit; verification gate (§1.4) will not catch
the bug if 1.3.11 is skipped because the failure mode is a hang, not a
specific test failure.

### 1.1 Why this stage

Removes the workaround chain (`_diag[col]` set in `_createFillin`,
`_elCol[e]` rewrite in `_swapColumns`, `_linkRows()` call from
`preorder()`). Establishes the ngspice contract that "row chains do not
exist during assembly or preorder". Every later stage assumes this.

### 1.2 Files touched

- `src/solver/analog/sparse-solver.ts`
- `src/solver/analog/__tests__/sparse-solver.test.ts` (white-box tests
  asserting eager row-link state will need to be re-expressed)

### 1.3 Specific edits

| Edit # | Old (file:line) | New | ngspice ref |
|---|---|---|---|
| 1.3.1 | (no field) | Add `private _rowsLinked: boolean = false;` after `_factored` (line 232 area) | `MatrixFrame.RowsLinked` (`spdefs.h:771`) |
| 1.3.2 | `allocElement` line 364 unconditionally calls `_insertIntoRow` | Wrap in `if (this._rowsLinked) this._insertIntoRow(newE, row);` | `spcCreateElement` `spbuild.c:776` |
| 1.3.3 | `_createFillin` line 1085 unconditionally calls `_insertIntoRow` | Wrap in `if (this._rowsLinked) this._insertIntoRow(fe, row);` | (Fill-ins are created during factor only — `_rowsLinked` will always be true at this point — but gate it for invariant.) |
| 1.3.4 | `_createFillin` line 1094 `if (row === col) this._diag[col] = fe;` | DELETE the line. Move the diag-set into `_newElement` (edit 1.3.5). | `spcCreateElement` sets `Diag[Row] = pElement` at `spbuild.c:851` (unlinked) and `spbuild.c:793` (linked) — single sink. |
| 1.3.5 | `_newElement` lines 1021-1039 do not set `_diag` | After the row/col fields are assigned (line 1031-1032), add `if (row === col) this._diag[col] = e;`. | `spbuild.c:793` and `spbuild.c:851` |
| 1.3.6 | `allocElement` line 366 sets `_diag[internalCol] = newE` | DELETE the line. The `_newElement` call at 363 now centralises the set. | (centralisation per ngspice) |
| 1.3.7 | `_swapColumns` lines 828-833 walk swapped chains and rewrite `_elCol[e]` | DELETE the entire post-swap rewrite block. | `SwapCols` `sputils.c:283-301` does not touch element fields. |
| 1.3.8 | `preorder` line 756 `if (anySwap) this._linkRows();` | DELETE the line. Remove the now-dead `anySwap` local declared at line 720. | `spMNA_Preorder` `sputils.c:177-230` does not touch row chains. |
| 1.3.9 | `factorWithReorder` lines 1427-1448 do not gate on `_rowsLinked` | At top of method body, before `_applyDiagGmin`, add `if (!this._rowsLinked) { this._linkRows(); this._rowsLinked = true; }`. | `spOrderAndFactor` `spfactor.c:246-247` |
| 1.3.10 | `invalidateTopology` lines 666-674 do not clear `_rowsLinked` | Add `this._rowsLinked = false;` to the body. | `spStripMatrix` `sputils.c:1111` |
| 1.3.11 | `_linkRows` writes `_elPrevInRow[e]` (lines 777-778) but does NOT write `_elCol[e]` | TWO edits: (a) KEEP the prev-pointer maintenance for now; deleted in Stage 2. (b) ADD `this._elCol[e] = col;` inside the inner column-walk loop, before the row-chain head insert. Mirrors ngspice `spcLinkRows` at `spbuild.c:923` (`pElement->Col = Col;`). Without this write, edit 1.3.7 (which removes `_swapColumns`'s `_elCol[e]` rewrite) leaves `_elCol[e]` permanently stale for every element on a swapped column. The two edits are coupled — see §1.0. | `spbuild.c:923` |
| 1.3.12 | `_initStructure` does not set `_rowsLinked` | Add `this._rowsLinked = false;` in the same block as `this._factored = false;` (lines 992-996). | `spalloc.c:173` |
| 1.3.13 | `_resetForAssembly` does not touch `_rowsLinked` | Confirm: `_rowsLinked` MUST stay true across `_resetForAssembly` (NR loop re-stamp). | `spClear` `spbuild.c:96-142` does not clear `RowsLinked`. |

### 1.4 Verification gate

Run with the ngspice harness:

- All currently-passing `sparse-solver.test.ts` tests that do NOT depend
  on the eager-row-link side effects (about 25 of 32). The 7 white-box
  tests asserting `markowitzRow.length === 3` and
  `_elCol_preserved_after_preorder_swap` may regress further or change
  shape. Both are acknowledged-stale per session findings §3.5; if they
  break, document the breakage and move on.
- `harness-integration.test.ts` — all 29 must still pass.
- `sparse-reset-semantics.test.ts` — must still pass.
- `resistive-divider` parity (DC-OP and transient) — must pass.
- `_diag-rc-transient` — must pass.
- 1-ULP failures (`rc-transient`, `rlc-oscillator`) — may persist or may
  resolve. Not a blocker for moving to Stage 2.

### 1.5 Rollback signal

If `resistive-divider` or `_diag-rc-transient` regresses, the lazy-link
gate is wrong. Suspect a missed `_rowsLinked` check at a row-chain
read site. Do not patch around it. Revert Stage 1 and re-audit
`Grep`-list of every read of `_rowHead`, `_elNextInRow`, `_elPrevInRow`.

If the harness shows Markowitz pivot search picking pivots inconsistent
with the post-preorder column structure (or the suite hangs in
`_numericLUMarkowitz` / `_countMarkowitz` after the first preorder
swap), suspect a missing `_elCol[e] = col` write inside `_linkRows()`.
Verify against `spbuild.c:923` (`pElement->Col = Col;`). Edit 1.3.11
must add this write — see §1.0 dependency note.

---

## Stage 2 — Delete the doubly-linked prev pointers

### 2.1 Why this stage

`_elPrevInRow` and `_elPrevInCol` are digiTS-only. ngspice uses singly-
linked chains and a `prev` local rebuilt per walk. Removing them halves
the chain-mutation surface area and brings the `_exchangeColElements` /
`_exchangeRowElements` code paths to a literal port.

### 2.2 Files touched

- `src/solver/analog/sparse-solver.ts`

### 2.3 Specific edits

| Edit # | Old (file:line) | New | ngspice ref |
|---|---|---|---|
| 2.3.1 | Lines 83, 87 declare `_elPrevInRow`, `_elPrevInCol` | DELETE both fields. | n/a |
| 2.3.2 | `_initStructure` lines 947, 949 allocate them | DELETE both lines. | n/a |
| 2.3.3 | `_growElements` (lines 1166-1167) grows them | DELETE the two `growI(this._elPrev*)` calls. | n/a |
| 2.3.4 | `_newElement` lines 1035, 1037 reset them | DELETE both lines. | n/a |
| 2.3.5 | `_insertIntoRow` (lines 1051-1064) maintains `_elPrevInRow` | Replace with the C idiom: walk the row from head with a `prev` local; insert between `prev` and `cur`. No prev-pointer maintenance. | `spbuild.c:809-837` |
| 2.3.6 | `_insertIntoCol` (lines 1112-1125) maintains `_elPrevInCol` | Same as 2.3.5 mirrored for col. | `spbuild.c:805-807` |
| 2.3.7 | `_removeFromRow` (lines 1127-1133) | Replace: remove must walk the row from head to find `prev`, then re-link. (Or accept that no production path needs `_removeFromRow` — see Grep — and DELETE the function entirely.) | (ngspice has no `_removeFromRow`) |
| 2.3.8 | `_removeFromCol` (lines 1135-1141) | Same as 2.3.7 for col. | (ngspice removes during `ExchangeColElements` via the local `prev` walk.) |
| 2.3.9 | `_setColLink` (lines 2117-2121) | Replace body with the C `*PtrToPtr = X` idiom: `if (prev < 0) this._colHead[col] = e; else this._elNextInCol[prev] = e;`. Remove the `_elPrevInCol[e] = prev` write. | `spfactor.c:2302-2385` `*ElementAboveRow = X` |
| 2.3.10 | `_setRowLink` (lines 2127-2131) | Same as 2.3.9 for row. | `spfactor.c:2431-2514` `*ElementLeftOfCol = X` |
| 2.3.11 | `_exchangeColElements` (lines 2146-2240) | Audit each `if (X >= 0) this._elPrevInCol[X] = Y;` line — every one MUST go. After the prev arrays are gone the spec is `_setColLink(prev, e, col)` for every C `*PtrToPtr = X`. | `spfactor.c:2302-2385` |
| 2.3.12 | `_exchangeRowElements` (lines 2247-2341) | Same as 2.3.11 mirrored. | `spfactor.c:2431-2514` |
| 2.3.13 | `_linkRows` (lines 768-783) | Remove the `_elPrevInRow[e] = -1` and `_elPrevInRow[oldHead] = e` lines. The C original (`spbuild.c:921-928`) is a head-insert with no prev maintenance. | `spbuild.c:907-932` |

### 2.4 Verification gate

- All Stage 1 passing tests must still pass.
- The chain-walk routines that previously read prev (`_removeFromRow`,
  `_removeFromCol`) must either be deleted or rewritten with a local-walk
  prev. Use `Grep` for `_elPrev` after editing — there must be zero hits.
- `_exchangeColElements` and `_exchangeRowElements` are the highest-risk
  functions in this stage. If the harness reports first-divergence inside
  `_exchangeColElements` after Stage 2, the most likely cause is a
  missed `*PtrToPtr` translation. Diff the C original character-by-
  character against the TS body.

### 2.5 Rollback signal

Any `Markowitz*`-related test or `factor` test failing after this stage
indicates a missed prev-pointer translation. Revert and re-port
`_exchangeColElements` line-by-line against `spfactor.c:2302-2385`.

---

## Stage 3 — Delete `_handleTable` and dual-branch in `allocElement`

### 3.1 Why this stage

The handle table is a digiTS-only optimisation that creates `O(n^2)`
memory and a stale-after-preorder hazard. ngspice does the column-chain
walk per stamp. Stamps run at NR-iteration cadence, but the per-stamp
cost is `O(col-chain-length)` — typically `O(1)` per row.

### 3.2 Files touched

- `src/solver/analog/sparse-solver.ts`

### 3.3 Specific edits

| Edit # | Old (file:line) | New | ngspice ref |
|---|---|---|---|
| 3.3.1 | Lines 138-139 declare `_handleTable`, `_handleTableN` | DELETE both fields. | n/a |
| 3.3.2 | `_initStructure` lines 967-968 allocate the table | DELETE both lines. | n/a |
| 3.3.3 | `allocElement` lines 317-321 (handle table fast path) | DELETE the entire `if (this._n > 0 && this._n <= this._handleTableN) { ... }` block. | n/a |
| 3.3.4 | `allocElement` lines 332-334 (handle table store on hit) | DELETE the inner `if (this._n <= this._handleTableN) { ... }` block. | n/a |
| 3.3.5 | `allocElement` lines 370-372 (handle table store on alloc) | DELETE the post-alloc store. | n/a |
| 3.3.6 | `allocElement` rewritten body | The body is now the column-chain walk plus the alloc path. Translate to the literal `spcFindElementInCol` + `spcCreateElement` two-call structure (see 3.3.7 and 3.3.8). | `spbuild.c:265-318, 363-393, 776-871` |
| 3.3.7 | (no method) | Add `private _spcFindElementInCol(colHead: number, row: number, col: number, createIfMissing: boolean): number` mirroring `spbuild.c:362-393`. Returns the existing element index, or calls `_spcCreateElement` (3.3.8) if not found and `createIfMissing` is true, else returns -1. | `spbuild.c:362-393` |
| 3.3.8 | (no method) | Add `private _spcCreateElement(row: number, col: number, lastE: number, fillin: boolean): number` mirroring `spbuild.c:768-871`. Branches on `_rowsLinked`. Sets `_diag` if diagonal. Splices into column at `lastE`. If `_rowsLinked`, also performs the row-search-and-splice. Sets `_needsReorder = true` if `!fillin`. | `spbuild.c:768-871` |
| 3.3.9 | `_newElement` (1021-1039) | KEEP as the lowest-level pool advance. `_spcCreateElement` calls it. Diag-set already moved here in Stage 1.3.5. | `spcGetElement` `spalloc.c:310-364` |
| 3.3.10 | `_createFillin` (1083-1109) | Replace body with a call to `_spcCreateElement(row, col, /*lastE for col-splice*/, /*fillin=*/ true)` plus the Markowitz / Singletons bookkeeping (lines 1097-1106 — keep, mirrors `CreateFillin` `spfactor.c:2818-2826`). | `CreateFillin` `spfactor.c:2799-2829` |

### 3.4 Verification gate

- All Stage 2 tests must still pass.
- Worst case is per-stamp performance regression. Run the largest-circuit
  performance test currently in suite. Bound: factor-time should not
  increase by more than 2x.

### 3.5 Rollback signal

Any "topology incorrect" failure (singular factor where it should not be,
missing element, extra element) after Stage 3 indicates the
`_spcFindElementInCol` / `_spcCreateElement` split is not faithful to
`spbuild.c:768-871`. Revert and re-port.

---

## Stage 4 — Delete dead workspace fields

### 4.1 Why this stage

`_q`, `_pinv`, `_elMark`, `_rowToElem` are dead. `_elFreeHead` is dead in
practice. Removing them shrinks the field surface to match `MatrixFrame`.

### 4.2 Files touched

- `src/solver/analog/sparse-solver.ts`

### 4.3 Specific edits

| Edit # | Old (file:line) | New | Justification |
|---|---|---|---|
| 4.3.1 | Lines 157-158 declare `_pinv`, `_q` | DELETE both. | Never read by `solve()`. |
| 4.3.2 | Lines 277, 282 declare `_elMark`, `_rowToElem` | DELETE both. | Never read. |
| 4.3.3 | `_initStructure` lines 963-964, 971-972 allocate them | DELETE the four lines. | n/a |
| 4.3.4 | `_allocateWorkspace` lines 1187-1191 reallocate them | DELETE the four lines. | n/a |
| 4.3.5 | `_exchangeRowsAndCols` lines 2354-2356, 2408-2409 write them | DELETE both writes. | `ExchangeRowsAndCols` `spfactor.c:1986-2070` does not. |
| 4.3.6 | Line 131 `_elFreeHead`, line 952 init, line 1023-1025 free-list reuse | If no caller will ever delete a fill-in, DELETE the free-list. Recommended: DELETE; ngspice's fill-in re-allocation comes from a different list (`spcGetFillin` `spalloc.c:475-518`) and there is no production path in digiTS that returns a fill-in to the pool. | `spalloc.c:475-518` |
| 4.3.7 | `_allocateWorkspace` (1181-1192) | KEEP only the `_scratch` reallocation (line 1189). The rest is dead. | `spcCreateInternalVectors` `spfactor.c:706-747` |
| 4.3.8 | Line 79 declares `_elFlags: Uint8Array`; line 57 declares `const FLAG_FILL_IN = 1` | DELETE the field, the constant, and every read site. Sequencing requirement: this edit must run **after Stage 5** has stripped the `FLAG_FILL_IN`-gated row/col counts inside `finalize()` (lines 458, 466) — the Markowitz precompute moves into `_spOrderAndFactor` and the new ngspice `CountMarkowitz` does not distinguish fill-ins from originals (`spfactor.c:792-810`). | `MatrixElement` (`spdefs.h:441-452`) has no flags field; fill-ins are tracked by counter (`Matrix->Fillins`) and pool list, not per-element. |
| 4.3.9 | `_initStructure` line 945 allocates `_elFlags`; `_growElements` line 1164 grows it; `_newElement` line 1033 resets it; `_createFillin` line 1084 sets `FLAG_FILL_IN`; `getCSCNonZeros` line 924 / `_takePreFactorSnapshotIfEnabled` line 905 / `elementCount` line 2503 / `finalize` lines 458, 466 read it | DELETE every site. `getCSCNonZeros`, `_takePreFactorSnapshotIfEnabled` and `elementCount` lose the fill-in filter; that is correct, because Stage 4B replaces walk-and-filter counting with the `_originals` / `_fillins` counters. | `spbuild.c:786-790, 847, 870`; `spfactor.c:2799-2829` |
| 4.3.10 | Verification — implementer Greps for `_elFlags` and `FLAG_FILL_IN` in the entire repo after this edit | Both must return zero hits. If a test reads `_elFlags`, the test is white-box on a digiTS-only field and must be deleted or rewritten against the `_originals` / `_fillins` counters. | n/a |

### 4.4 Verification gate

- All Stage 3 tests must still pass. (No behavioural change expected.)
- `Grep` for the deleted field names in the entire codebase — there must
  be zero hits. If a test file reads `_q` or `_pinv` for white-box
  assertions, the test must be deleted.

### 4.5 Rollback signal

Any test failure after Stage 4 indicates the field was actually read.
Identify the reader and either translate it to the ngspice mechanism
(`IntToExtRowMap` for permutation) or delete the test as white-box
instrumentation.

---

## Stage 4A — Restructure `beginAssembly` to mirror `SMPclear` + first-call `spCreate`

### 4A.1 Why this stage

Gap 8 resolution. Today's `beginAssembly` is a digiTS-shaped composition
of two ngspice phases:

- **Steady state** (re-stamp pass): the body must mirror `SMPclear`
  (`spsmp.c:141-147`) which calls `spClear` (`spbuild.c:96-142`). `spClear`
  walks `FirstInCol[I]` for `I = Size..1` and zeros `pElement->Real`; sets
  `Factored = NO`; clears the `TrashCan`; sets `SingularRow/Col = 0`.
- **First call** (after construct or `invalidateTopology`): the alloc
  block mirrors `spCreate` (`spalloc.c:160-200`) plus the deferred
  `spcCreateInternalVectors` (`spfactor.c:706-747`).

The **RHS-zero loop at line 422 has no ngspice home**. ngspice's NR loop
in `niiter.c` resets RHS itself; `spClear` does not touch RHS. Per
banned-pattern guard rule #9 the RHS-zero is removed.

### 4A.2 Files touched

- `src/solver/analog/sparse-solver.ts`
- Caller of `beginAssembly` that depends on RHS being zeroed by the
  solver (likely `src/solver/analog/ckt-load.ts` or similar — implementer
  identifies via `Grep` for `beginAssembly`).

### 4A.3 Specific edits

| Edit # | Old (file:line) | New | ngspice ref |
|---|---|---|---|
| 4A.3.1 | `beginAssembly` line 422 `this._rhs.fill(0, 0, this._n);` | DELETE the line. Per banned-pattern guard rule #9. The caller (NR loop) is now responsible. | `spClear` (`spbuild.c:96-142`) does not touch RHS. |
| 4A.3.2 | `beginAssembly` lines 415-419 dispatch on `_structureEmpty` | KEEP the dispatch. Add a comment at the top of `beginAssembly` citing `SMPclear` (`spsmp.c:141-147`) for the steady-state branch and `spCreate` (`spalloc.c:160-200`) + `spcCreateInternalVectors` (`spfactor.c:706-747`) for the first-call branch. | `spsmp.c:141-147`, `spalloc.c:160-200`, `spfactor.c:706-747` |
| 4A.3.3 | `beginAssembly` lines 425-433 Markowitz array reallocation | After Stage 5, this block is not reached on every call (Stage 5 deleted the `else { fill(0) }`). Verify after Stage 5 that this block now runs only on the first-call path inside `_initStructure`. If it remains in `beginAssembly`, move the allocation into `_initStructure` so `beginAssembly`'s steady-state body is purely `spClear`-equivalent. | `spcCreateInternalVectors` `spfactor.c:706-747` allocates once. |
| 4A.3.4 | `_resetForAssembly` is called from `beginAssembly` line 418 | Verify the call site lands inside `beginAssembly` exactly where ngspice's `SMPclear` calls `spClear`. No code change here; just a comment cross-reference. | `spsmp.c:144` |
| 4A.3.5 | At top of `beginAssembly`, add ngspice-citation header comment | Mirror the format used by `solve()` (sparse-solver.ts:543-565) — name the ngspice entry point, the file:line range, the variable map. | (citation hygiene per Final Stage acceptance criteria) |

### 4A.4 Verification gate

- All Stage 4 tests must still pass.
- If any test now fails because RHS was implicitly zeroed by the solver
  on `beginAssembly` entry, that test exposes a **caller bug**: the
  caller must zero its own RHS (or delegate to a clear hook) before the
  next stamp pass. **Fix the caller, not the solver.** Per project rule
  "No Pragmatic Patches".
- `harness-integration.test.ts` (29 tests) — must pass. If any fail, the
  caller chain (`ckt-load.ts` and the NR loop) is the patch site.

### 4A.5 Rollback signal

If a parity test that previously passed now fails with a single-step
RHS divergence (i.e. `rhsOld[i]` non-zero where ngspice has zero),
the caller has not been wired to zero RHS. Wire the caller; do NOT
restore the in-solver fill.

---

## Stage 4B — Introduce `_elements`, `_originals`, `_fillins` counters

### 4B.1 Why this stage

`MatrixFrame` carries `Elements`, `Originals`, `Fillins` integer
counters (`spdefs.h:743, 749, 763`). digiTS does not. The counters
support `spStripMatrix`'s zero-out (`sputils.c:1113-1115`) and the
`spElementCount`/`spOriginalCount`/`spFillinCount` query API. They are
statistics not behaviour, but they are part of the `MatrixFrame`
contract; absence from digiTS forces every consumer that wants a count
to walk chains and filter (today via `_elFlags & FLAG_FILL_IN`, which
Stage 4 deletes).

### 4B.2 Files touched

- `src/solver/analog/sparse-solver.ts`

### 4B.3 Specific edits

| Edit # | Old (file:line) | New | ngspice ref |
|---|---|---|---|
| 4B.3.1 | (no fields) | Add `private _elements = 0; private _originals = 0; private _fillins = 0;` near the other `MatrixFrame`-mirror fields. | `MatrixFrame.Elements`, `Originals`, `Fillins` (`spdefs.h:743, 749, 763`) |
| 4B.3.2 | `_initStructure` lines 992-996 | Add `this._elements = 0; this._originals = 0; this._fillins = 0;`. Mirrors `spCreate` (`spalloc.c:165, 167-168`). | `spalloc.c:165, 167-168` |
| 4B.3.3 | `_spcCreateElement` (Stage 3.3.8) — non-fillin branch | Increment `this._originals++; this._elements++;` at the same point ngspice does. ngspice writes `Matrix->Originals++` at `spbuild.c:787` (linked branch) and `spbuild.c:847` (unlinked branch); writes `Matrix->Elements++` at `spbuild.c:870`. | `spbuild.c:787, 847, 870` |
| 4B.3.4 | `_spcCreateElement` — fillin branch | Increment `this._fillins++; this._elements++;`. ngspice writes `Matrix->Fillins++` at `spbuild.c:782` and `Matrix->Elements++` at `spbuild.c:870`. | `spbuild.c:782, 870` |
| 4B.3.5 | `_createFillin` (post-Stage-3 form) | The fillin-branch increments at 4B.3.4 cover this; verify by tracing the call site. | `CreateFillin` `spfactor.c:2799-2829` |
| 4B.3.6 | `getCSCNonZeros`, `elementCount`, `_takePreFactorSnapshotIfEnabled` | These walked chains and filtered on `FLAG_FILL_IN` (deleted in Stage 4). After Stage 4B they may continue the walk for the value snapshot but no longer need the filter — they emit every live element regardless. The `elementCount` accessor (line 2497-2508) becomes `return this._originals;` (matching `spOriginalCount` `spalloc.c:879`). | `spalloc.c:859, 869, 879` |
| 4B.3.7 | (no public method) | Optionally expose `get fillinCount(): number { return this._fillins; }` and `get totalElementCount(): number { return this._elements; }` to mirror `spFillinCount` / `spElementCount` for harness consumers — these are not test-only fields, they are `MatrixFrame` contract. | `spalloc.c:859-885` |

### 4B.4 Verification gate

- All Stage 4A tests must still pass.
- After running any factor on a non-trivial circuit, assert
  `_elements === _originals + _fillins` in a small unit test (or
  document the invariant in a top-of-file comment).
- `Grep` for any remaining chain-walk-with-filter pattern; the only
  legal sites are the snapshot accessors that need per-element data,
  and even they no longer need the fill-in filter.

### 4B.5 Rollback signal

If `_originals` and `_fillins` drift apart from the chain truth (e.g.
counter shows 5 originals but a chain walk shows 4), an `_spcCreateElement`
caller is bypassing the counter increment — find the bypass.

---

## Stage 4C — Expand `invalidateTopology` to mirror `spStripMatrix`

### 4C.1 Why this stage

Today `invalidateTopology` (lines 666-674) sets four flags and relies on
`_structureEmpty` to trigger `_initStructure` reallocation on the next
`beginAssembly`. ngspice's `spStripMatrix` (`sputils.c:1106-1145`) does
materially more: it clears every chain head, every diag pointer, and
the element/fill-in counters; it also resets the element-list and
fill-in-list cursors so the next allocation reuses the existing pool.
Stage 1.3.10 already added one missing field (`_rowsLinked = false`).
This stage enumerates the rest.

### 4C.2 Files touched

- `src/solver/analog/sparse-solver.ts`

### 4C.3 Specific edits

| Edit # | Old (file:line) | New | ngspice ref |
|---|---|---|---|
| 4C.3.1 | `invalidateTopology` body (lines 666-674) | Expand to clear/reset the following, in this order: | `sputils.c:1106-1145` |
| 4C.3.2 | `_rowsLinked = false` (already added in Stage 1.3.10) | Confirm present. | `sputils.c:1111` |
| 4C.3.3 | `_needsReorder = true` (already present) | Confirm. | `sputils.c:1112` |
| 4C.3.4 | `_factored = false` (already present) | Confirm. | (`spClear` sets it `spbuild.c:137`; `spStripMatrix` does not write `Factored` directly but sets `NeedsOrdering = YES` which subsumes it via `IS_FACTORED`.) |
| 4C.3.5 | `_didPreorder = false` (already present) | Confirm. See escalation §F.5 — ngspice does not reset `Reordered` here; we deliberately reset `_didPreorder` because `spStripMatrix` strips the matrix entirely. | n/a |
| 4C.3.6 | `_elements = 0; _originals = 0; _fillins = 0;` | ADD. Stage 4B counter zero-out. | `sputils.c:1113-1115` |
| 4C.3.7 | `for (let i = 1; i <= n; i++) { _rowHead[i] = -1; _colHead[i] = -1; _diag[i] = -1; }` (1-based after Stage 7; or `for i = 0; i < n; i++` pre-Stage-7) | ADD. Mirrors `sputils.c:1138-1143`. | `sputils.c:1138-1143` |
| 4C.3.8 | Pool reset: `_elCount = 0; _elFreeHead = -1;` | ADD. Mirrors the element-list and fill-in-list cursor reset (`sputils.c:1117-1133`). After Stage 4 deletes the free-list, `_elFreeHead` is gone — only `_elCount = 0` remains. | `sputils.c:1117-1133` |
| 4C.3.9 | Capture buffers (post-Stage-8 these live elsewhere): `_preFactorMatrix = null` if still on the class | ADD if still inside `SparseSolver` after Stage 8; otherwise the wrapper handles it. | n/a |
| 4C.3.10 | DELETE `this._structureEmpty = true;` from line 667 | After this stage, the structure is materially empty after `invalidateTopology` runs. The next `beginAssembly` must NOT call `_initStructure` again (the typed arrays are still allocated and the right size). Convert `_structureEmpty` to a simple `_n === 0` check, or delete the flag and inspect `_n`/`_elements` directly. | (matches `spStripMatrix` semantics: keeps the matrix frame, resets contents.) |

### 4C.4 Verification gate

- All Stage 4B tests must still pass.
- After `invalidateTopology` then `beginAssembly(n)` then a stamp pass,
  the resulting matrix must be bit-identical to a fresh `_initStructure`-
  produced one (excluding pool capacity, which carries forward).
- `sparse-reset-semantics.test.ts` — must pass; this is the canary.

### 4C.5 Rollback signal

If any test that calls `invalidateTopology` now produces a different
post-rebuild matrix than a fresh-construct does, the field-by-field
clear is incomplete. Compare to `sputils.c:1106-1145` line by line.

---

## Stage 5 — Move Markowitz precompute into the port of `spOrderAndFactor`

### 5.1 Why this stage

`finalize()` calls `CountMarkowitz` (-equivalent) and `MarkowitzProducts`
(-equivalent) eagerly. ngspice runs these only inside `spOrderAndFactor`
(`spfactor.c:255-256`), gated to once per reorder. Eager precompute is
wasted work AND opens Hypothesis D.1.A (different fill-in handling).

### 5.2 Files touched

- `src/solver/analog/sparse-solver.ts`

### 5.3 Specific edits

| Edit # | Old (file:line) | New | ngspice ref |
|---|---|---|---|
| 5.3.1 | `finalize` lines 447-482 | Strip body to: (a) optional `_preSolveRhs` capture (lines 476-481, kept as instrumentation; in Stage 8 it moves out), nothing else. Markowitz arrays do not need re-init here; they are re-init'd inside `_numericLUMarkowitz` startStep=0 path (sparse-solver.ts:1218-1220). | `spClear` does not touch Markowitz arrays. |
| 5.3.2 | `beginAssembly` lines 425-433 | Keep the `_markowitz*` allocation block (sizing depends on `n`), but DELETE the `else { fill(0) }` branch. The arrays are zeroed inside `_countMarkowitz` and `_markowitzProducts` per the `Step..Size` walk. | `spcCreateInternalVectors` `spfactor.c:706-747` allocs once and never re-zeros. |
| 5.3.3 | `_numericLUMarkowitz` line 1217-1221 | The `if (startStep === 0) { ... }` block already runs `_countMarkowitz` and `_markowitzProducts`. KEEP. This is the ngspice-equivalent point. | `spfactor.c:255-256` |

### 5.4 Verification gate

- All Stage 4 tests must still pass.
- The 1-ULP `rc-transient` and `rlc-oscillator` failures should be
  rerun. **If they now pass at zero ULP**, Hypothesis D.1.A was correct.
  If they still fail at the same ULP, the cause is elsewhere (likely
  the dispatch graph divergence — Stage 6).

### 5.5 Rollback signal

Any test that was passing in Stage 4 and now fails indicates the eager
Markowitz precompute was load-bearing for that test (the test was
asserting on `markowitzProd[i]` between `finalize()` and `factor()`).
Such tests are white-box and stale; delete the assertion or move it to
assert post-factor state. Do not restore the eager precompute.

---


---

## Stage 5A — Convert `_resetForAssembly` to ngspice `spClear` chain walk

### 5A.1 Why this stage

**Mandatory.** `_resetForAssembly` (sparse-solver.ts:1005-1011) loops
linearly over the pool: `for (let e = 0; e < elCount; e++) elVal[e] = 0`.
ngspice's `spClear` (`spbuild.c:96-142`) walks the column chains:

```
for (I = Matrix->Size; I > 0; I--) {
    pElement = Matrix->FirstInCol[I];
    while (pElement != NULL) {
        pElement->Real = 0.0;
        pElement = pElement->NextInCol;
    }
}
```

The two strategies have different memory-access patterns and (after Stage
4 deletes the free-list) the chain walk is the only one that touches
exactly the live elements. The pool-linear walk also touches any pool
slot that was once allocated and never released, including any leftover
from a prior `invalidateTopology`-then-rebuild cycle. Per the project
"Equality or nothing" rule, the conversion is mandatory.

### 5A.2 Files touched

- `src/solver/analog/sparse-solver.ts`

### 5A.3 Specific edits

| Edit # | Old (file:line) | New | ngspice ref |
|---|---|---|---|
| 5A.3.1 | `_resetForAssembly` body (lines 1005-1011): `for (let e = 0; e < elCount; e++) elVal[e] = 0;` | Replace with the ngspice chain walk: `for (let i = n; i > 0; i--) { let e = this._colHead[i]; while (e >= 0) { this._elVal[e] = 0; e = this._elNextInCol[e]; } }` (1-based after Stage 7; pre-Stage-7 use `for (let i = n - 1; i >= 0; i--)`). | `spbuild.c:108-117` (real branch) and `spbuild.c:121-129` (real-only branch — same body) |
| 5A.3.2 | `_resetForAssembly` adds `_factored = false;` | Mirrors `spClear` `spbuild.c:137`. | `spbuild.c:137` |
| 5A.3.3 | `_resetForAssembly` adds `_singularRow = 0; _singularCol = 0;` (after Stage 6A introduces these fields) | Mirrors `spClear` `spbuild.c:138-139`. Sequencing note: this row depends on Stage 6A; if 6A has not landed when this stage runs, defer this row until both stages are in. | `spbuild.c:138-139` |
| 5A.3.4 | `_resetForAssembly` does NOT touch `NeedsOrdering` | Confirm. ngspice `spClear` does not touch `NeedsOrdering` either. | `spbuild.c:96-142` (no `NeedsOrdering` write) |
| 5A.3.5 | At top of `_resetForAssembly`, add ngspice-citation header comment naming `spClear` (`spbuild.c:96-142`) | Required by Final Stage acceptance criteria. | n/a |

### 5A.4 Verification gate

- `harness-integration.test.ts` (29 tests) — all must still pass. This is
  the primary canary: every NR-loop test exercises `_resetForAssembly`
  on every NR iteration.
- Any NR-loop test (transient, DC sweep) — must still pass.
- `sparse-reset-semantics.test.ts` — must pass.
- After this stage runs, `Grep` for the old `for (let e = 0; e < elCount; e++)`
  pattern inside `_resetForAssembly` — must return zero hits.

### 5A.5 Rollback signal

If any NR-loop test newly fails with stale-value symptoms (a stamp from
the previous iteration not zeroed), the chain walk is missing a column
or skipping a chain. The most likely cause is an off-by-one on the
loop bound — recheck against `spbuild.c:108-117` literally.
## Stage 6 — Collapse the dispatch graph into `spOrderAndFactor` + `spFactor`

### 6.1 Why this stage

ngspice has one entry point for "factor": `spOrderAndFactor`, with two
consecutive loops sharing a local `Step` counter (the `if (!NeedsOrdering)`
reuse loop at `spfactor.c:214-228`, fall-through into the
`if (ReorderingRequired)` reorder loop at `spfactor.c:240+`). digiTS has
four methods: `factor`, `factorWithReorder`, `factorNumerical`,
`_numericLUMarkowitz` — and the C3 fix in this session was an attempt to
emulate the shared-`Step` semantics across the dispatch boundary. The
clean port collapses them.

There is also a separate ngspice entry, `spFactor` (`spfactor.c:323-414`),
which is the reuse-only path with the partition / direct-addressing
optimisation. The partition optimisation is OUT OF SCOPE per §0.4. The
real distinction we keep:

- `spOrderAndFactor` = port of the full reorder, with the inline reuse-loop
- `spFactor` = port of the reuse-only path (without partition; falls back
  to `spOrderAndFactor` when `NeedsOrdering`). This is the entry from
  `SMPluFac` (`spsmp.c:174`).

### 6.2 Files touched

- `src/solver/analog/sparse-solver.ts`
- `src/solver/analog/__tests__/sparse-solver.test.ts` (re-shape any test
  that named `factorNumerical` or `factorWithReorder`; the new public
  surface is `factor(diagGmin?)` only)

### 6.3 Specific edits

| Edit # | Old (file:line) | New | ngspice ref |
|---|---|---|---|
| 6.3.1 | `factor` (503-538), `factorWithReorder` (1427-1448), `factorNumerical` (1454-1468), `_numericLUMarkowitz` (1204-1303), `_numericLUReusePivots` (1330-1417) | Replace ALL FIVE with: (a) public `factor(diagGmin?)` mirroring `SMPluFac` semantics — applies gmin, calls `_spFactor` (next item), or falls through to `_spOrderAndFactor`. (b) private `_spFactor` mirroring `spfactor.c:323-414` minus the partition path. (c) private `_spOrderAndFactor` mirroring `spfactor.c:192-284` with the two consecutive loops sharing the local `Step`. (d) private `_realRowColElimination` mirroring `RealRowColElimination` `spfactor.c:2553-2598` — the per-pivot elimination kernel. | `spfactor.c:192-284`, `spfactor.c:323-414`, `spfactor.c:2553-2598`; `spsmp.c:169-200` |
| 6.3.2 | (no method) | Extract the elimination kernel currently inline at `_numericLUMarkowitz` lines 1259-1285 and `_numericLUReusePivots` lines 1373-1400 into a single `private _realRowColElimination(pivotE)`. Both `_spOrderAndFactor` and `_spFactor` call it. | `spfactor.c:2553-2598` |
| 6.3.3 | `lastFactorUsedReorder: boolean` (line 255) | DELETE the field. ngspice has no such accessor. | n/a |
| 6.3.4 | `FactorResult.rejectedAtStep` (line 37) and the C3 fall-through path in `factor` lines 515-535 | DELETE both. The fall-through is now intra-method inside `_spOrderAndFactor`. | `spfactor.c:214-228, 240-281` |
| 6.3.5 | `_numericLUMarkowitz(startStep)` (line 1204) | DELETE the public-surface signature. The shared-`Step` semantics are now a function-local in `_spOrderAndFactor`. | `spfactor.c:192-284` |
| 6.3.6 | `_numericLUReusePivots` (lines 1330-1417) | DELETE. Its body becomes the `if (!NeedsOrdering)` branch inside `_spOrderAndFactor`. | `spfactor.c:214-228` |

The new file structure under this stage:

```
public factor(diagGmin?: number): FactorResult     // SMPluFac equivalent
  -> _applyDiagGmin(gmin)
  -> if (_needsReorder || !_factored) -> _spOrderAndFactor()
    else -> _spFactor()
private _spOrderAndFactor(): FactorResult           // spfactor.c:192-284
  -> if (!_rowsLinked) _linkRows()
  -> step = 0
  -> if (!_needsReorder):
      for (step = 0; step < n; step++):
        pivot = _diag[step]
        largestInCol = _findLargestInCol(_elNextInCol[pivot])
        if (largestInCol * relThreshold < |elVal[pivot]|):
          _realRowColElimination(pivot)
        else:
          break  // shared Step continues
  -> if (we reached the end without break): goto Done
  -> CountMarkowitz(rhs, step)
  -> MarkowitzProducts(step)
  -> for (; step < n; step++):
      pivot = _searchForPivot(step)
      if (pivot < 0) return MatrixIsSingular(step)
      _exchangeRowsAndCols(pivot, step)
      _realRowColElimination(pivot)
      _updateMarkowitzNumbers(pivot)
  Done:
  _needsReorder = false; _factored = true
private _spFactor(): FactorResult                   // spfactor.c:323-414
  -> if (_needsReorder) return _spOrderAndFactor()
  -> for (step = 0; step < n; step++):
      pivotE = _diag[step]
      if (pivotE < 0 || elVal[pivotE] == 0) return ZeroPivot(step)
      elVal[pivotE] = 1.0 / elVal[pivotE]
      _realRowColElimination(pivotE)
  _factored = true
private _realRowColElimination(pivotE): void        // spfactor.c:2553-2598
  -> store reciprocal pivot at diag (already done by caller in _spFactor;
    not done by caller in _spOrderAndFactor — kernel handles it)
  -> outer-product loop: pUpper walks pivotRow.NextInRow, pLower walks
    pivotCol.NextInCol, pSub walks pUpper's column with row-alignment
    advance, fill-in via _createFillin when missing
```

### 6.4 Verification gate

- All Stage 5 tests must still pass.
- The 1-ULP `rc-transient` and `rlc-oscillator` failures should be
  rerun. **This is the most likely point at which they finally resolve**
  — the C3 fix was a workaround for the dispatch graph divergence, and
  Stage 6 removes the divergence. If they still fail at this stage, run
  the ngspice harness and report the first divergent iteration.
- Run the full parity suite. Document any test that newly passes (the
  port resolved it) and any that newly fails (the port broke it).

### 6.5 Rollback signal

If any DC-OP-only test (no NR loop) now fails, the kernel extraction is
incorrect; check `_realRowColElimination` against `RealRowColElimination`
(`spfactor.c:2553-2598`) line by line.

If the reuse loop now fails to fall through correctly, the
"shared `Step`" implementation is wrong — verify the local is declared
ONCE at the top of `_spOrderAndFactor` and not reset in the second
loop's `for` initializer.

---


---

## Stage 6A — Restore `Error` / `SingularRow` / `SingularCol`

### 6A.1 Why this stage

`MatrixFrame` carries `Error`, `SingularRow`, `SingularCol`
(`spdefs.h:744, 772, 773`) and ngspice writes them at every site that
detects a numerical or structural problem. Consumers (NR loop,
dynamic-gmin ladder, `spSMALL_PIVOT` warning logic) dispatch off these
fields. digiTS today returns only a boolean `success` plus an optional
`singularRow` on `FactorResult` — the caller cannot distinguish
`spSINGULAR` ("no acceptable pivot at this step") from `spSMALL_PIVOT`
("threshold relaxed; using `pLargestElement`") from `spZERO_DIAG`
("structural diagonal zero with no symmetric twin"). This stage
restores the distinction.

### 6A.2 Files touched

- `src/solver/analog/sparse-solver.ts`

Downstream consumer wiring (NR loop / dynamic-gmin ladder / source-step
ladder dispatch off `Matrix->Error`) is **explicitly deferred** to a
follow-up spec. This stage only restores the writes; the readers stay
on the boolean `success` until their port lands. Named call sites that
will eventually need the wiring:

- `src/solver/analog/newton-raphson.ts` — NR-iteration dispatch (ngspice
  `niiter.c` reads `Matrix->Error` to decide between iterate, gmin-step,
  source-step, abandon).
- `src/solver/analog/dc-operating-point.ts` — DCOP ladder (ngspice
  `cktop.c::dynamicgmin` reads `Matrix->Error == spSINGULAR` to ramp
  gmin down).
- Any device-load function that calls `spOriginalCount` / `spError` —
  unlikely in current digiTS; named for completeness.

### 6A.3 Specific edits

| Edit # | Old (file:line) | New | ngspice ref |
|---|---|---|---|
| 6A.3.1 | (no fields) | Add `private _error: number = 0; private _singularRow: number = 0; private _singularCol: number = 0;` near the other `MatrixFrame`-mirror fields. Add module-level `const spOKAY = 0; const spSMALL_PIVOT = 2; const spZERO_DIAG = 3; const spSINGULAR = 4; const spMANGLED = 5; const spNO_MEMORY = 6; const spPANIC = 7; const spFATAL = spPANIC;` mirroring `spmatrix.h` (the public ngspice values). | `MatrixFrame.Error/SingularRow/SingularCol` (`spdefs.h:744, 772, 773`); error codes per `ngspice/spmatrix.h` |
| 6A.3.2 | `_initStructure` and `spCreate` initial state | Add `this._error = spOKAY; this._singularRow = 0; this._singularCol = 0;`. Mirrors `spalloc.c:166, 175-176`. | `spalloc.c:166, 175-176` |
| 6A.3.3 | `_spOrderAndFactor` entry | Add `this._error = spOKAY;`. Mirrors `spfactor.c:202`. | `spfactor.c:202` |
| 6A.3.4 | `_searchEntireMatrix` (post-Stage-6 form) `if (chosen >= 0) return chosen;` else fallback path | When the fallback returns `pLargestElement`, write `this._error = spSMALL_PIVOT;` first. When `largestElementMag === 0` (true singular), write `this._error = spSINGULAR;` and the original-row/original-col into `_singularRow`/`_singularCol` via `_intToExtRow[step]`/`_preorderColPerm[step]`. ngspice writes these inside `MatrixIsSingular` (`spfactor.c`) and `ZeroPivot` (`spfactor.c`). | `spfactor.c::MatrixIsSingular` (called at `spfactor.c:262`); `spfactor.c::ZeroPivot` (called at `spfactor.c:348, 382, 407`); `spfactor.c:1799-1809` (SearchEntireMatrix fallback path) |
| 6A.3.5 | `_searchForPivot` returning `-1` (no acceptable pivot at all) | Caller path is already covered by `_spOrderAndFactor`'s `MatrixIsSingular(step)` translation in 6A.3.6. No edit at this site; just confirm error code propagates. | `spfactor.c:262` |
| 6A.3.6 | (no method) | Add `private _matrixIsSingular(step: number): FactorResult { this._error = spSINGULAR; this._singularRow = this._intToExtRow[step]; this._singularCol = this._preorderColPerm[step]; return { success: false, error: spSINGULAR, singularRow: this._singularRow, singularCol: this._singularCol }; }`. Mirrors ngspice's `MatrixIsSingular` (`spfactor.c::MatrixIsSingular`, called at `spfactor.c:262`). | `spfactor.c::MatrixIsSingular` (line ~2657) |
| 6A.3.7 | (no method) | Add `private _zeroPivot(step: number): FactorResult { this._error = spZERO_DIAG; this._singularRow = this._intToExtRow[step]; this._singularCol = this._preorderColPerm[step]; return { success: false, error: spZERO_DIAG, singularRow: this._singularRow, singularCol: this._singularCol }; }`. Mirrors ngspice's `ZeroPivot` (`spfactor.c::ZeroPivot`, called at `spfactor.c:348, 382, 407`). | `spfactor.c::ZeroPivot` (line ~2680) |
| 6A.3.8 | `_spFactor` (post-Stage-6) zero-pivot returns | Replace bare `return { success: false, ... }` with `return this._zeroPivot(step);` at every site `spFactor` calls `ZeroPivot`. | `spfactor.c:348, 382, 407` |
| 6A.3.9 | `_spOrderAndFactor` (post-Stage-6) singular-pivot return | Replace bare `return { success: false, ... }` after `_searchForPivot` returns -1 with `return this._matrixIsSingular(step);`. | `spfactor.c:262` |
| 6A.3.10 | `_spOrderAndFactor` post-Done success path | Set `this._error = spOKAY;` (defensive — already set at entry, but ngspice does not re-set; confirm this is not needed; if not, omit). | `spfactor.c:283` returns `Matrix->Error` |
| 6A.3.11 | `FactorResult` interface (lines 17-37) | Extend with `error?: number; singularRow?: number; singularCol?: number;` (singularRow already exists; add `error` and `singularCol`). Public `factor()` returns these on every result. | `MatrixFrame.Error/SingularRow/SingularCol` |
| 6A.3.12 | (no method) | Add public `getError(): number { return this._error; }`, `whereSingular(): { row: number; col: number } { return { row: this._singularRow, col: this._singularCol }; }`. Mirror `spError` (`spalloc.c:712-724`) and `spWhereSingular` (`spalloc.c:749-762`). | `spalloc.c:712-724, 749-762` |
| 6A.3.13 | `_resetForAssembly` (post-Stage-5A) | Add `this._error = spOKAY; this._singularRow = 0; this._singularCol = 0;`. Mirrors `spClear` `spbuild.c:136-139`. | `spbuild.c:136-139` |
| 6A.3.14 | `invalidateTopology` (post-Stage-4C) | Add the same three writes. | `sputils.c` strip semantics |

### 6A.4 Verification gate

- All Stage 6 tests must still pass.
- A new white-box unit test should assert that on a known-singular
  matrix (e.g. all-zero diagonal with no twins) `factor()` returns
  `error === spSINGULAR` AND `singularRow`/`singularCol` map to a real
  caller-side row/col.
- A second white-box unit test asserts that on a small-pivot matrix
  (one row weakly diagonal-dominant, threshold tight) `factor()`
  returns `error === spSMALL_PIVOT` AND `success === true` (small-pivot
  is a warning, not a failure).
- `Grep` for `Matrix->Error` in `ref/ngspice/src/maths/sparse/spfactor.c`
  to enumerate every write site; confirm each has a digiTS counterpart.

### 6A.5 Rollback signal

If a test that previously passed now fails because the boolean
`success` flipped (e.g. from `true` to `false` because `spSMALL_PIVOT`
was misinterpreted as failure), the wiring at one of the return sites
is wrong. Per ngspice, `spSMALL_PIVOT` is not a failure — `Factored = YES`
still gets set. Confirm `_spFactor`/`_spOrderAndFactor` set `_factored`
even when `_error === spSMALL_PIVOT`.

### 6A.6 Deferred follow-up

After Stage 6A lands, dispatch a separate spec to wire the named
downstream consumers (`newton-raphson.ts`, `dc-operating-point.ts`)
off the new `error` field. Until that spec lands, those consumers
continue to dispatch off the boolean `success` — that does NOT
regress anything (they were doing it that way before this stage), but
they also do not yet exploit the `spSMALL_PIVOT` distinction.

---

## Stage 6B — Delete `solve()` `if (n === 0) return` early-exit

### 6B.1 Why this stage

`solve()` at sparse-solver.ts:568 has `if (n === 0) return;`. ngspice's
`spSolve` (`spsolve.c:127-191`) has no such guard. Per banned-pattern
guard rule #1 ("Do not introduce safety guards that ngspice does not
have"), the guard is removed.

### 6B.2 Files touched

- `src/solver/analog/sparse-solver.ts`

### 6B.3 Specific edits

| Edit # | Old (file:line) | New | ngspice ref |
|---|---|---|---|
| 6B.3.1 | `solve()` line 568 `if (n === 0) return;` | DELETE the line. | `spSolve` (`spsolve.c:127-191`) has no equivalent guard. The function is asserted-VALID + asserted-FACTORED at `spsolve.c:137`, both of which presuppose `Size >= 1`. |
| 6B.3.2 | Confirm no caller invokes `solve()` on an `n === 0` solver | If a caller does, that caller has its own bug — fix the caller. The solver does not protect against caller bugs that ngspice does not protect against. | n/a |

### 6B.4 Verification gate

- All Stage 6A tests must still pass.
- If any test now throws a typed-array out-of-bounds error from inside
  `solve()` on an `n === 0` matrix, that test was relying on the
  digiTS-only guard — fix the test or the caller (do not restore the
  guard).

### 6B.5 Rollback signal

None expected — no production caller should be invoking `solve()` on a
zero-size matrix. If the harness reports that some test path does, the
finding goes to the user before any guard is restored.
## Stage 7 — Indexing convention

### 7.1 Why this stage

ngspice is 1-based throughout. digiTS is 0-based throughout. "Semantic
equivalence" is a banned closing verdict. The strict-port options are:

(a) Convert `sparse-solver.ts` to 1-based throughout. Allocate `n + 1`
arrays, leave slot 0 unused, write `for k = 1; k <= n; k++` loops.

(b) Document a single mechanical translation rule (digiTS `k` ⇔ ngspice
`Step = k + 1`) and apply it uniformly across the file with a top-of-file
header comment. Leave 0-based code as-is.

**Recommendation: (a).** The 0-based convention is the source of small
off-by-one risks in every loop (e.g. `_searchForSingleton` line 1676
"Size+1 maps to index n (since Size = n - 1)").

### 7.2 Files touched

- `src/solver/analog/sparse-solver.ts` (most lines touched of any stage)
- All call sites that read slot indices from the solver.

### 7.3 Specific edits

| Edit # | Scope | Description |
|---|---|---|
| 7.3.1 | All chain heads (`_rowHead`, `_colHead`, `_diag`, `_intToExtRow`, `_extToIntRow`, `_preorderColPerm`, `_extToIntCol`, `_markowitz*`) | Allocate length `n + 1`. Slot 0 unused. Length checks updated. |
| 7.3.2 | All loops `for (let k = 0; k < n; k++)` | Convert to `for (let k = 1; k <= n; k++)`. |
| 7.3.3 | All loops `for (let k = n - 1; k >= 0; k--)` | Convert to `for (let k = n; k >= 1; k--)`. |
| 7.3.4 | All `_diag[k]` reads | Reads `[1, n]` after conversion. |
| 7.3.5 | `solve()` permutation arrays `_intToExtRow[k]`, `_preorderColPerm[k]` | Same. The caller-supplied `x` and `_rhs` are still original-row keyed; the indirection uses the 1-based slot. |
| 7.3.6 | `_searchForSingleton`, `_quicklySearchDiagonal`, `_searchDiagonal`, `_searchEntireMatrix` | The sentinel comments `// our index n (since Size = n - 1)` go away; pointer reads at `mProd[Size + 1]` become `mProd[n + 1]` exactly. |
| 7.3.7 | Public surface `allocElement(row, col)`, `stampRHS(row, value)`, `solve(x)` | Caller's `row`/`col` is original-numbered. RHS and solution arrays remain 0-based for compatibility with caller storage. |

If decision (a) is too disruptive, fall back to (b). Do not mix the two
conventions inside one method.

### 7.4 Verification gate

- All Stage 6 tests must still pass.
- The 7 white-box `sparse-solver.test.ts` tests asserting
  `markowitzRow.length === 3` will need updating to `=== 4` (n + 1)
  for an n=3 test matrix.

### 7.5 Rollback signal

If conversion creates more bugs than it removes (per the harness), the
mechanical translation is the wrong call. Roll back to 0-based plus
the documented translation rule (option b).

---

## Stage 8 — Move test instrumentation out of the production class

### 8.1 Why this stage

`enablePreSolveRhsCapture`, `getPreSolveRhsSnapshot`,
`enablePreFactorMatrixCapture`, `getPreFactorMatrixSnapshot`,
`getCSCNonZeros`, `getRhsSnapshot`, `_takePreFactorSnapshotIfEnabled`,
the white-box accessors `dimension`/`markowitzRow`/`markowitzCol`/
`markowitzProd`/`singletons`/`elementCount` are digiTS-only by necessity
(test instrumentation). Eighty-plus lines of production-class surface
area.

### 8.2 Files touched

- `src/solver/analog/sparse-solver.ts`
- New file `src/solver/analog/sparse-solver-instrumentation.ts` exporting
  a free function or class that wraps a `SparseSolver` and exposes the
  capture API.
- All test files that import from `SparseSolver` for white-box
  assertions.

### 8.3 Specific edits

| Edit # | Scope | Description |
|---|---|---|
| 8.3.1 | Lines 169-170, 181-182, 854-931, 2497-2508 | Cut entire test-instrumentation block. |
| 8.3.2 | `factorWithReorder` line 1434, `factorNumerical` line 1458 (or their post-Stage-6 successors) | Remove `_takePreFactorSnapshotIfEnabled` calls. Replace with a single hook the instrumentation module can subscribe to. |
| 8.3.3 | `finalize` lines 476-481 (or its post-Stage-5 successor) | Remove `_preSolveRhs` capture. Same hook mechanism. |
| 8.3.4 | New file | `SparseSolverInstrumentation` class wrapping a `SparseSolver` with the capture / snapshot / accessor surface. Tests import this class for white-box; production code never imports it. |

If the file split is judged too disruptive, the alternative is a
prefix marker (`__instrumentation_*`) on every test-only field/method
and a lint rule ensuring production code never reads them.

### 8.4 Verification gate

- All Stage 7 tests must still pass with the test-side import switched
  to the instrumentation wrapper.

### 8.5 Rollback signal

None — this stage is purely mechanical relocation.

---

## Final Stage — Bit-Exact Parity Sweep

### F.1 Run the full ngspice parity suite

Per `docs/ngspice-harness-howto.md`. Document zero divergences as the
exit criterion.

### F.2 Classify the formerly-open issues

For each open issue in `spec/sparse-solver-parity-audit/00-session-findings.md` §3:

| Open issue | Expected disposition after port |
|---|---|
| 1-ULP `rc-transient`, `rlc-oscillator` | Resolved by Stage 5 (Markowitz precompute timing) and/or Stage 6 (dispatch graph). If still failing, run the harness; the divergence should now point outside `sparse-solver.ts`. |
| `opamp-inverting` 4-decade RHS gap | Not resolved by the port. Lives in `newton-raphson.ts` source-stepping ladder. Out of scope; document the still-failing test and dispatch a separate audit. |
| `mosfet-inverter` VBD state-init | Not resolved by the port. Lives in MOS device load functions. Out of scope; dispatch a separate audit. |
| `diode-bridge` parity test "hang" | Not resolved by the port. Lives in `ComparisonSession`. Out of scope; dispatch a separate harness audit. |
| `sparse-solver.test.ts` x 7 white-box | Updated to 1-based (Stage 7) or deleted as stale (Stage 4 / Stage 8). Document the disposition. |
| `ckt-context.test.ts loadCtx_fields_populated`, `dcop-init-jct.test.ts` x 3 | Not resolved by the port. LoadContext fixture issue, unrelated. |

### F.3 Acceptance criteria — gate to "port complete"

- Every parity test currently expected to pass: bit-exact pass against
  ngspice harness. Zero ULP delta.
- Vitest suite green (excluding the explicitly out-of-scope LoadContext
  fixture failures and the white-box sparse-solver tests already updated
  per Stage 7 and Stage 8).
- No new digiTS-only fields introduced (verified by `Grep` against the
  field list in `00-structural-review.md` §A).
- Every method in `sparse-solver.ts` carries a top-of-method comment
  citing the ngspice file:line range it ports (verified by manual code
  review).
- `_handleTable`, `_pinv`, `_q`, `_elMark`, `_rowToElem`,
  `_elPrevInRow`, `_elPrevInCol`, `_elFreeHead`, `_elFlags`,
  `FLAG_FILL_IN` are all gone. (`Grep` zero hits.)
- `_rowsLinked` field present and used as the single point of truth for
  row-link state. (`Grep` confirms read sites.)
- `_elements`, `_originals`, `_fillins` instance fields present and
  incremented at the same sites ngspice does (`Grep` for
  `_originals++`, `_fillins++`, `_elements++` matches the ngspice
  write-site list in Stage 4B.3).
- `_error`, `_singularRow`, `_singularCol` instance fields present;
  `FactorResult.error` and `FactorResult.singularCol` extended;
  `getError()` / `whereSingular()` public accessors mirror
  `spError` / `spWhereSingular`.
- `factor()` is the only public factor entry. `factorWithReorder` and
  `factorNumerical` are gone. (`Grep` zero hits.)
- `_numericLUMarkowitz` and `_numericLUReusePivots` are gone, replaced
  by `_spOrderAndFactor` / `_spFactor` / `_realRowColElimination`.
  (`Grep` zero hits.)
- `finalize()` no longer calls `_countMarkowitz` or `_markowitzProducts`.
  (`Grep` confirms call sites are inside `_spOrderAndFactor` only.)
- `solve()` no longer carries the `if (n === 0) return` early-exit
  guard (`Grep` confirms zero hits inside `solve()`).
- `_resetForAssembly` body matches the ngspice `spClear` chain walk
  (`for (I = Size; I > 0; I--) { for (pE = FirstInCol[I]; ...) }`).
- `beginAssembly` no longer zeros RHS (`Grep` for `_rhs.fill` inside
  `beginAssembly` returns zero hits).
- `invalidateTopology` clears every field `spStripMatrix` clears
  (verified by manual diff against `sputils.c:1106-1145`).

### F.4 Banned in the final report

When closing the port, the implementer's status note must NOT use:
"semantic equivalence", "no numerical impact", "tolerance", "intentional
divergence", "architectural simplification", "mapping table" as a
closing verdict, "pre-existing" as an excuse, "partial" as a verdict.

If the implementer reaches a divergence they cannot port without one of
these words, the divergence is escalated to the user with a specific
question — not closed in the implementation report.

---

## References

- `spec/sparse-solver-direct-port/00-structural-review.md` — companion review
- `spec/lazy-row-link-port.md` — Stage 1 reference
- `spec/sparse-solver-parity-audit/00-session-findings.md` — currently passing/failing tests, C3 fix history
- `spec/sparse-solver-parity-audit/01..04*.md` — per-area audit raw classifications
- `src/solver/analog/sparse-solver.ts` — the file under port
- `ref/ngspice/src/maths/sparse/spdefs.h:69` — IS_FACTORED predicate
- `ref/ngspice/src/maths/sparse/spdefs.h:733-788` — MatrixFrame struct
- `ref/ngspice/src/maths/sparse/spalloc.c:160-200` — spCreate (target for `_initStructure`)
- `ref/ngspice/src/maths/sparse/spbuild.c:96-142` — spClear (target for `_resetForAssembly`)
- `ref/ngspice/src/maths/sparse/spbuild.c:768-871` — spcCreateElement (target for Stage 3)
- `ref/ngspice/src/maths/sparse/spbuild.c:907-932` — spcLinkRows (target for `_linkRows`, Stage 1)
- `ref/ngspice/src/maths/sparse/sputils.c:177-230` — spMNA_Preorder (target for `preorder`, Stage 1)
- `ref/ngspice/src/maths/sparse/sputils.c:283-301` — SwapCols (target for `_swapColumns`, Stage 1)
- `ref/ngspice/src/maths/sparse/sputils.c:1106-1145` — spStripMatrix (target for `invalidateTopology`, Stage 1)
- `ref/ngspice/src/maths/sparse/spfactor.c:192-284` — spOrderAndFactor (target for Stage 6)
- `ref/ngspice/src/maths/sparse/spfactor.c:323-414` — spFactor (target for Stage 6)
- `ref/ngspice/src/maths/sparse/spfactor.c:706-747` — spcCreateInternalVectors (target for Stage 5)
- `ref/ngspice/src/maths/sparse/spfactor.c:782-826` — CountMarkowitz
- `ref/ngspice/src/maths/sparse/spfactor.c:866-896` — MarkowitzProducts
- `ref/ngspice/src/maths/sparse/spfactor.c:2553-2598` — RealRowColElimination (target for `_realRowColElimination`, Stage 6)
- `ref/ngspice/src/maths/sparse/spfactor.c:2799-2829` — CreateFillin (target for `_createFillin`, Stage 1 + Stage 3)
- `ref/ngspice/src/maths/sparse/spsmp.c:169-200` — SMPluFac, SMPreorder bodies (entry contract)
- `ref/ngspice/src/maths/sparse/spsmp.c:422-440` — LoadGmin (target for `_applyDiagGmin`, already PORT)
- `ref/ngspice/src/maths/sparse/spsolve.c:127-191` — spSolve (target for `solve`, already PORT)
- `docs/ngspice-harness-howto.md` — verification instrument (per CLAUDE.md hard rule)
