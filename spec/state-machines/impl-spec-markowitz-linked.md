# Markowitz Fill-In Tracking — Implementation Spec

## Goal

Replace magnitude-primary pivot selection in `_numericLUMarkowitz` with true Markowitz-primary selection matching ngspice's `spOrderAndFactor`. This requires a parallel-array doubly-linked-list overlay that tracks fill-in during elimination so Markowitz row/column counts stay accurate.

## Why This Is Needed

CSC is a static structure. When fill-in occurs during Gaussian elimination (a zero entry becomes nonzero), CSC cannot represent the new entry. Markowitz counts computed from CSC become stale after a few elimination steps. Using stale counts as the primary pivot criterion causes catastrophic numerical instability on real MNA circuits.

ngspice solves this with `ElementPtr->NextInRow`/`NextInCol` doubly-linked lists that grow when fill-in occurs.

## Data Structure

### Parallel-Array Element Pool

All arrays are TypedArrays. Initial capacity = `nnzA * 3` (allocated in `_symbolicLU`). Pool grows lazily (double) if fill-in exceeds capacity.

```typescript
// Element pool — parallel arrays, each of length _elCapacity
private _elRow: Int32Array;       // AMD-permuted row of element e
private _elCol: Int32Array;       // AMD-permuted column of element e
private _elNextInRow: Int32Array; // next element in same row (-1 = end)
private _elPrevInRow: Int32Array; // prev element in same row (-1 = head)
private _elNextInCol: Int32Array; // next element in same column (-1 = end)
private _elPrevInCol: Int32Array; // prev element in same column (-1 = head)

// Head pointers — length n
private _rowHead: Int32Array;     // first element in row r (-1 = empty)
private _colHead: Int32Array;     // first element in column c (-1 = empty)
private _diag: Int32Array;        // element index of diagonal (r,r) or -1

// Allocation
private _elCount: number;         // next free slot
private _elCapacity: number;      // current pool size

// Fill-in detection marker — length n
private _elMark: Int32Array;      // _elMark[row] = column of last mark
```

Values are NOT stored in the pool — they stay in the existing dense workspace `x[]`. The linked structure is topology-only.

## File Changes

### `src/solver/analog/sparse-solver.ts`

All changes are within the SparseSolver class.

#### New private fields

Add all fields listed above. Initialize to empty arrays (`new Int32Array(0)`) in the field declarations.

#### `_symbolicLU()` — add allocation

After the existing L/U allocation block (~line 717), add allocation for the linked structure arrays:

```
const elCap = Math.max(nnzA * 3, n * 4);
this._elRow = new Int32Array(elCap);
this._elCol = new Int32Array(elCap);
this._elNextInRow = new Int32Array(elCap);
this._elPrevInRow = new Int32Array(elCap);
this._elNextInCol = new Int32Array(elCap);
this._elPrevInCol = new Int32Array(elCap);
this._elCapacity = elCap;
this._rowHead = new Int32Array(n).fill(-1);
this._colHead = new Int32Array(n).fill(-1);
this._diag = new Int32Array(n).fill(-1);
this._elMark = new Int32Array(n).fill(-1);
```

#### NEW: `_allocElement(row, col)` → element index

Allocates a slot from the pool. If `_elCount >= _elCapacity`, double all 6 element arrays (same pattern as `_growL`/`_growU`).

```
private _allocElement(row: number, col: number): number {
  if (this._elCount >= this._elCapacity) this._growElements();
  const e = this._elCount++;
  this._elRow[e] = row;
  this._elCol[e] = col;
  this._elNextInRow[e] = -1;
  this._elPrevInRow[e] = -1;
  this._elNextInCol[e] = -1;
  this._elPrevInCol[e] = -1;
  return e;
}
```

#### NEW: `_insertIntoRow(e, row)` / `_insertIntoCol(e, col)`

Insert element `e` at the head of the row/column chain. O(1).

```
private _insertIntoRow(e: number, row: number): void {
  const head = this._rowHead[row];
  this._elNextInRow[e] = head;
  this._elPrevInRow[e] = -1;
  if (head >= 0) this._elPrevInRow[head] = e;
  this._rowHead[row] = e;
}
// _insertIntoCol symmetric
```

#### NEW: `_removeFromRow(e)` / `_removeFromCol(e)`

Doubly-linked removal. O(1).

```
private _removeFromRow(e: number): void {
  const prev = this._elPrevInRow[e];
  const next = this._elNextInRow[e];
  if (prev >= 0) this._elNextInRow[prev] = next;
  else this._rowHead[this._elRow[e]] = next;
  if (next >= 0) this._elPrevInRow[next] = prev;
}
// _removeFromCol symmetric
```

#### NEW: `_buildLinkedMatrix()`

Build linked structure from CSC. Called at the top of `_numericLUMarkowitz`, replacing `_countMarkowitz()` + `_markowitzProducts()`.

```
private _buildLinkedMatrix(): void {
  const n = this._n;
  this._elCount = 0;
  this._rowHead.fill(-1);
  this._colHead.fill(-1);
  this._diag.fill(-1);
  this._elMark.fill(-1);

  // Walk CSC in AMD-permuted order
  for (let amdCol = 0; amdCol < n; amdCol++) {
    const origCol = this._perm[amdCol];
    for (let p = this._cscColPtr[origCol]; p < this._cscColPtr[origCol + 1]; p++) {
      const amdRow = this._permInv[this._cscRowIdx[p]];
      const e = this._allocElement(amdRow, amdCol);
      this._insertIntoRow(e, amdRow);
      this._insertIntoCol(e, amdCol);
      if (amdRow === amdCol) this._diag[amdRow] = e;
    }
  }

  // Compute initial Markowitz counts from linked structure
  const mRow = this._markowitzRow;
  const mCol = this._markowitzCol;
  const mProd = this._markowitzProd;
  let singletons = 0;

  for (let i = 0; i < n; i++) {
    let rc = 0;
    let e = this._rowHead[i];
    while (e >= 0) { rc++; e = this._elNextInRow[e]; }
    mRow[i] = rc > 0 ? rc - 1 : 0; // exclude diagonal

    let cc = 0;
    e = this._colHead[i];
    while (e >= 0) { cc++; e = this._elNextInCol[e]; }
    mCol[i] = cc > 0 ? cc - 1 : 0;

    mProd[i] = mRow[i] * mCol[i];
    if (mProd[i] === 0 && (mRow[i] <= 1 || mCol[i] <= 1)) singletons++;
  }
  this._singletons = singletons;
}
```

#### MODIFY: `_numericLUMarkowitz()` — add fill-in tracking

After the triangular solve loop (current lines 848-862) and before `_searchForPivot`:

```
// Detect and record fill-in entries in column k
// Mark existing entries in column k
let me = this._colHead[k];
while (me >= 0) {
  this._elMark[this._elRow[me]] = k;
  me = this._elNextInCol[me];
}

// Check all nonzero rows — if unmarked and unpivoted, it's fill-in
for (let idx = 0; idx < xNzCount; idx++) {
  const i = xNzIdx[idx];
  if (x[i] === 0 || pinv[i] >= 0) continue;
  if (this._elMark[i] === k) continue; // existing entry
  // Fill-in at (i, k)
  const e = this._allocElement(i, k);
  this._insertIntoRow(e, i);
  this._insertIntoCol(e, k);
  this._markowitzRow[i]++;
  this._markowitzCol[k]++;
}
```

Also replace the call to `_countMarkowitz()` + `_markowitzProducts()` at the top with `_buildLinkedMatrix()`.

#### REWRITE: `_searchForPivot()` — Markowitz-primary

Replace the current magnitude-primary search with true 4-phase Markowitz:

**Phase 1 (Singletons):** If `_singletons > 0`, walk unpivoted rows where `mProd[i] === 0`. Among those with `|x[i]| >= relThreshold`, pick largest magnitude. Return if found.

**Phase 2 (Diagonal preference):** Among unpivoted diagonals passing magnitude threshold, find minimum `mProd[i]`. Return if found.

**Phase 3 (Column search):** Walk `_colHead[k]` chain via `_elNextInCol`. Among unpivoted rows with `|x[row]| >= relThreshold`, find minimum `mRow[row] * mCol[k]` product. Tiebreak by largest magnitude. Return if found.

**Phase 4 (Fallback):** Largest magnitude among all unpivoted rows (current behavior).

The relative threshold is `PIVOT_THRESHOLD * absMax` (unchanged).

#### REWRITE: `_updateMarkowitzNumbers()` — walk linked lists

Replace the current CSC-walking implementation:

```
private _updateMarkowitzNumbers(step: number, pivotRow: number, pinv: Int32Array): void {
  const mRow = this._markowitzRow;
  const mCol = this._markowitzCol;
  const mProd = this._markowitzProd;

  // Walk pivot ROW — decrement column counts
  let e = this._rowHead[pivotRow];
  while (e >= 0) {
    const c = this._elCol[e];
    const next = this._elNextInRow[e];
    if (c !== step && mCol[c] > 0) mCol[c]--;
    this._removeFromCol(e);
    e = next;
  }
  this._rowHead[pivotRow] = -1;

  // Walk pivot COLUMN — decrement row counts
  e = this._colHead[step];
  while (e >= 0) {
    const r = this._elRow[e];
    const next = this._elNextInCol[e];
    if (r !== pivotRow && mRow[r] > 0) mRow[r]--;
    this._removeFromRow(e);
    e = next;
  }
  this._colHead[step] = -1;

  // Recompute products and singletons
  let singletons = 0;
  for (let i = 0; i < this._n; i++) {
    if (pinv[i] >= 0) continue;
    mProd[i] = mRow[i] * mCol[i];
    if (mProd[i] === 0) singletons++;
  }
  this._singletons = singletons;
}
```

Note: The new signature drops the `x`, `xNzIdx`, `xNzCount` parameters — the linked structure replaces workspace-based traversal.

#### NEW: `_growElements()`

Double all 6 element arrays. Same pattern as `_growL`/`_growU`.

### `src/solver/analog/__tests__/sparse-solver.test.ts`

Add tests for:
1. `_buildLinkedMatrix` produces correct row/column counts matching `_countMarkowitz`
2. Fill-in detection: factor a matrix where fill-in is guaranteed, verify Markowitz counts increase
3. Markowitz-primary pivot selection: construct a matrix where Markowitz product differs from magnitude ranking, verify the lower-product pivot is chosen
4. `_updateMarkowitzNumbers` via linked lists produces same counts as walking CSC
5. Pool growth: verify `_growElements` is triggered on high-fill-in matrices

## What Does NOT Change

- COO assembly (`stamp`, `beginAssembly`, `finalize`)
- CSC conversion and AMD ordering
- L/U output format (CSC)
- `_numericLUReusePivots()` — no Markowitz needed on the hot path
- `factorNumerical()` — calls `_numericLUReusePivots`
- `solve()` — forward/backward substitution unchanged
- All public API surface

## Performance

- `_numericLUReusePivots` (hot path in transient): **zero cost** — no linked structure used
- `_numericLUMarkowitz` (reorder path): O(nnz) build + O(nnz_row + nnz_col) per-step update vs current O(n * density) per-step. Net: comparable or faster.
- Memory: ~25KB for 100-node circuits, ~186KB for 500-node circuits

## ngspice Variable Mapping

| ngspice (spfactor.c) | Ours |
|---|---|
| `Element->NextInRow` | `_elNextInRow[e]` |
| `Element->NextInCol` | `_elNextInCol[e]` |
| `Element->Row` | `_elRow[e]` |
| `Element->Col` | `_elCol[e]` |
| `MarkowitzRow[i]` | `_markowitzRow[i]` |
| `MarkowitzCol[i]` | `_markowitzCol[i]` |
| `MarkowitzProduct[i]` | `_markowitzProd[i]` |
| `Singletons` | `_singletons` |
| `CreateFillin()` | `_allocElement` + `_insertIntoRow` + `_insertIntoCol` |
| `UpdateMarkowitzNumbers()` | `_updateMarkowitzNumbers()` walking linked lists |
| `SearchForPivot()` | `_searchForPivot()` 4-phase Markowitz-primary |
