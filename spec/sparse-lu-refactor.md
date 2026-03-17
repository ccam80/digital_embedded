# Sparse LU Factorization Refactor

**Status:** Ready for implementation
**Date:** 2026-03-18
**Scope:** Replace dense O(n³) LU factorization in `SparseSolver` with genuine sparse LU operating on CSC structure
**File:** `src/analog/sparse-solver.ts`

---

## 1. Problem

The `SparseSolver` assembles sparse matrices correctly (COO → CSC → AMD ordering) but then **scatters everything into a dense n×n `Float64Array` and runs O(n³) Gaussian elimination**. This defeats the entire sparse pipeline.

### Current hot path (`_numericLU`, lines 439–525)

```
1. Allocate dense Float64Array(n × n)           ← O(n²) memory
2. Scatter CSC entries into dense buffer         ← O(nnz)
3. Dense Gaussian elimination with pivoting      ← O(n³) time
4. Store L/U factors in the same dense buffer    ← O(n²) memory
```

### Measured impact

| n | Spec target (factor) | Current measured | Ratio |
|---|---------------------|------------------|-------|
| 50 | 0.05ms | ~2.9ms | 58× slower |
| 200 | 0.2ms | ~186ms (projected) | ~930× slower |
| 1000 | 2ms | ~14.5s (projected) | ~7250× slower |

The factor runs **on every Newton-Raphson iteration** of **every timestep**. With 3–5 NR iterations per step, a 200-node circuit would need ~1 second per timestep — functionally unusable.

### What's correct and stays

- COO triplet assembly (`stamp`, `stampRHS`, `_growCOO`)
- COO → CSC conversion with duplicate summing (`_buildCSC`)
- AMD approximate minimum degree ordering (`_computeAMD`)
- Topology change detection (`_patternChanged`)
- `beginAssembly` / `finalize` / `invalidateTopology` public API
- `FactorResult` type

---

## 2. Solution: CSparse-Style Left-Looking Sparse LU

Replace the dense `_numericLU` / `_allocateNumericArrays` / dense `solve` with a genuine sparse LU factorization following Tim Davis's CSparse algorithm (public domain, "Direct Methods for Sparse Linear Systems" §6.1–§6.2).

### Algorithm overview

**Left-looking column-by-column elimination.** Process each column k of the permuted matrix from left to right. For column k, solve the sparse triangular system `L[:,0..k-1] * x = A[:,k]` to compute the k-th column of L and the k-th row of U simultaneously. Only entries in the **nonzero pattern** (predicted by symbolic analysis) are touched.

```
For k = 0, 1, ..., n-1:
  1. Scatter A[:,k] into dense workspace x[]     ← only nnz(A[:,k]) ops
  2. Solve L[0..k-1, 0..k-1] * x = x (in-place) ← sparse triangular solve
     using elimination tree reach to find which columns of L participate
  3. Partial pivot: find best |x[i]| for i >= k
  4. Swap pivot row
  5. Scale: x[i] /= x[k] for i > k               ← these become L[i,k]
  6. Gather x[] into sparse L[:,k] and U[k,:]      ← prune zeros
  7. Clear workspace                               ← scatter-reset pattern
```

### Complexity

- **Symbolic**: O(nnz(A) + nnz(L) + nnz(U)) — once per topology change
- **Numeric factor**: O(flops(L)) where flops(L) = Σ_k nnz(L[:,k])² — proportional to actual fill-in, not n³
- **Solve**: O(nnz(L) + nnz(U)) — sparse triangular solves

For a 50-node MNA matrix with ~250 entries and typical fill ratio of 2–3×:
- Dense: 50³ = 125,000 multiply-adds
- Sparse: ~250 × 3 × 5 ≈ 3,750 multiply-adds → **~33× fewer operations**

---

## 3. Data Structures

### 3.1 Elimination tree (symbolic phase output)

```typescript
/** Parent pointers: etree[j] = parent of column j in the elimination tree, or -1 for root. */
private _etree: Int32Array;
```

The elimination tree encodes the dependency structure of L: column j of L can have nonzeros only in rows that are ancestors of j in the tree. Computing it is O(nnz(A)) via the `cs_etree` algorithm.

### 3.2 Column counts (symbolic phase output)

```typescript
/** Number of nonzeros in each column of L (including diagonal). */
private _lColCount: Int32Array;

/** Total number of nonzeros in L (sum of _lColCount). */
private _lnz: number;

/** Total number of nonzeros in U (computed during symbolic phase). */
private _unz: number;
```

### 3.3 Sparse L factor (CSC format, pre-allocated)

```typescript
/** L column pointers: _lColPtr[j] to _lColPtr[j+1] index into _lRowIdx/_lVals. */
private _lColPtr: Int32Array;

/** L row indices (sorted within each column). */
private _lRowIdx: Int32Array;

/** L numeric values. */
private _lVals: Float64Array;
```

### 3.4 Sparse U factor (CSC format, pre-allocated)

```typescript
/** U column pointers. */
private _uColPtr: Int32Array;

/** U row indices. */
private _uRowIdx: Int32Array;

/** U numeric values. */
private _uVals: Float64Array;
```

### 3.5 Pivot permutation

```typescript
/** Row permutation from partial pivoting: pinv[i] = row of original matrix mapped to row i. */
private _pinv: Int32Array;
```

### 3.6 Dense workspace (reused each factorization)

```typescript
/** Dense scatter workspace, length n. Cleared via scatter-reset pattern (no fill(0)). */
private _x: Float64Array;

/** Integer mark array for reach computation, length n. */
private _mark: Int32Array;

/** Stack for DFS traversal during reach, length n. */
private _stack: Int32Array;
```

### Memory comparison

| n | Dense (current) | Sparse (new) | Ratio |
|---|----------------|--------------|-------|
| 50 | 20 KB (n²×8) | ~6 KB | 3× less |
| 200 | 320 KB | ~30 KB | 10× less |
| 1000 | 8 MB | ~200 KB | 40× less |

---

## 4. Symbolic Phase (`_symbolicLU`)

Replaces `_allocateNumericArrays`. Runs once per topology change.

### Steps

1. **Build elimination tree** from the AMD-permuted CSC matrix.
   - Algorithm: `cs_etree` — for each column j, walk up row indices and union-find to find the parent. O(nnz).

2. **Post-order the elimination tree** for cache-friendly traversal.
   - Algorithm: `cs_post` — DFS post-ordering. O(n).

3. **Compute column counts of L** using the elimination tree.
   - Algorithm: `cs_counts` — using first-descendant and level-ancestor arrays. O(nnz + n).
   - This gives an upper bound on nnz(L) without computing L.

4. **Pre-allocate L and U storage** in CSC format.
   - L: allocate `_lRowIdx` and `_lVals` of size `_lnz`. Set `_lColPtr` from cumulative column counts.
   - U: allocate similarly. Upper bound for U column counts mirrors L row counts (by symmetry of fill-in pattern under AMD).
   - If exact U counts are expensive, over-allocate by a factor (e.g., lnz) and compact after first numeric factorization.

5. **Allocate workspace arrays** (`_x`, `_mark`, `_stack`) of length n.

### Output

- `_etree`, `_lColPtr` (with pre-allocated storage), `_uColPtr` (with pre-allocated storage), workspace arrays.
- All subsequent `factor()` calls reuse these allocations.

---

## 5. Numeric Phase (`_numericLU`)

Replaces the current dense Gaussian elimination. Runs on every NR iteration.

### Algorithm: left-looking sparse LU with partial pivoting

```
Input:  AMD-permuted CSC matrix (colPtr, rowIdx, vals), elimination tree, pre-allocated L/U
Output: Sparse L (unit lower triangular, CSC), sparse U (upper triangular, CSC), pivot permutation

Initialize: _pinv[:] = -1, lnz = 0, unz = 0

For k = 0, 1, ..., n-1:
  // 1. REACH: find which columns of L are needed for column k
  //    DFS from nonzero rows of A[:,k] up the elimination tree
  top = reach(k)   // returns stack[top..n-1] = columns to process, in topological order

  // 2. SCATTER: load A[:,k] into dense workspace x[]
  for each entry (i, v) in column k of permuted A:
    x[i] = v

  // 3. SPARSE TRIANGULAR SOLVE: x = L[0..k-1, 0..k-1]^{-1} * x
  for j in stack[top..n-1]:     // topological order
    if j < k:
      // x[j] is finalized — subtract L[:,j] * x[j] from x
      for each (i, lij) in L[:,j] where i > j:
        x[i] -= lij * x[j]

  // 4. PARTIAL PIVOT: find best |x[i]| for i >= k
  pivot = argmax_{i >= k, pinv[i] < 0} |x[i]|
  if |x[pivot]| < 1e-300: return singular

  // Apply threshold pivoting (Markowitz criterion):
  //   accept row i if |x[i]| >= PIVOT_THRESHOLD * |x[pivot]|
  //   among qualifying rows, prefer lowest column count (Markowitz)

  // Record pivot
  _pinv[pivot] = k

  // 5. STORE U[:,k]: entries x[i] where pinv[i] < k (already eliminated rows)
  //    plus the diagonal x[pivot]
  for i with pinv[i] >= 0 and pinv[i] <= k:
    U[pinv[i], k] = x[i]

  // 6. SCALE & STORE L[:,k]: entries x[i] where pinv[i] < 0 (not yet pivoted)
  diagVal = x[pivot]
  for i with pinv[i] < 0:
    L[i, k] = x[i] / diagVal    // unit lower triangular (diagonal of L is 1, stored implicitly)

  // L diagonal = 1.0 (implicit)
  // U diagonal = x[pivot] (stored explicitly)

  // 7. CLEAR workspace: reset x[i] = 0 for all i that were touched
  //    (tracked via the reach set — no fill(0) needed)
```

### Reach computation (`_reach`)

DFS from the nonzero rows of A[:,k] upward through the elimination tree, marking visited nodes. Returns the columns of L that contribute to column k, in reverse topological order (suitable for forward substitution).

```
reach(k):
  top = n
  for each row i in A[:,k]:
    if not marked[i]:
      DFS up etree from i, pushing visited nodes onto stack
      mark all visited
  return top  // stack[top..n-1] = reach set in topological order
```

O(|reach|) per column — total across all columns is O(nnz(L)).

### Key properties

- **No dense n×n allocation** — L and U stored in sparse CSC
- **No fill(0) on workspace** — scatter-reset pattern clears only touched entries
- **No allocation on hot path** — all arrays pre-allocated in symbolic phase
- **Pivoting within sparse pattern** — pivot selection respects the symbolic structure

---

## 6. Solve Phase

Replace the current dense forward/backward substitution with sparse triangular solves.

### Algorithm

```
solve(x: Float64Array):
  b = _rhs
  n = _n

  // 1. Apply AMD + pivot permutation to RHS
  for i = 0 to n-1:
    scratch[_pinv[_perm[i]]] = b[i]
    // or equivalently, combine perm and pinv into a single permutation

  // 2. Forward substitution: L * y = b (L is unit lower triangular, CSC)
  for j = 0 to n-1:
    for each (i, lij) in L[:,j] where i > j:
      scratch[i] -= lij * scratch[j]

  // 3. Backward substitution: U * z = y (U is upper triangular, CSC)
  for j = n-1 downto 0:
    scratch[j] /= U[j,j]   // diagonal of U
    for each (i, uij) in U[:,j] where i < j:
      scratch[i] -= uij * scratch[j]

  // 4. Undo permutation: write into output x
  for i = 0 to n-1:
    x[_perm[i]] = scratch[_pinv[_perm[i]]]  // inverse of combined permutation
```

Complexity: O(nnz(L) + nnz(U)) — linear in the number of nonzeros, not n².

---

## 7. API Changes

**None.** The public API (`beginAssembly`, `stamp`, `stampRHS`, `finalize`, `factor`, `solve`, `invalidateTopology`, `FactorResult`) is unchanged. This is a purely internal refactor.

Internal changes:

| Removed | Replaced by |
|---------|-------------|
| `_luA: Float64Array` (dense n×n) | `_lColPtr`, `_lRowIdx`, `_lVals` (sparse L) |
| `_luPivot: Int32Array` | `_pinv: Int32Array` (row pivot inverse) |
| `_scratch: Float64Array` (length n) | `_x: Float64Array` (workspace, length n) + `_scratch` (solve workspace) |
| `_allocateNumericArrays()` | `_symbolicLU()` |
| Dense `_numericLU()` | Sparse `_numericLU()` |
| Dense forward/back in `solve()` | Sparse forward/back in `solve()` |

New internal methods:

| Method | Purpose |
|--------|---------|
| `_buildEtree()` | Compute elimination tree from AMD-permuted CSC |
| `_symbolicLU()` | Column counts, pre-allocate L/U storage |
| `_reach(k)` | DFS reach for column k (used in numeric LU) |

---

## 8. Implementation Plan

### Step 1: Elimination tree + symbolic analysis

Add `_buildEtree()` and `_symbolicLU()`. Wire into `finalize()` in place of `_allocateNumericArrays()`.

Key reference: CSparse `cs_etree` (Algorithm 4.4 in Davis), `cs_counts` (Algorithm 5.1).

### Step 2: Sparse numeric LU

Replace `_numericLU()` with the left-looking sparse column algorithm. Implement `_reach()` for DFS traversal.

Key reference: CSparse `cs_lu` (Algorithm 6.1 in Davis).

### Step 3: Sparse solve

Replace dense forward/backward substitution in `solve()` with sparse triangular solves on L and U CSC structures.

Key reference: CSparse `cs_lsolve`, `cs_usolve` (Algorithm 2.4, 2.5 in Davis).

### Step 4: Remove dead code

Delete `_luA`, `_luPivot`, dense-path `_allocateNumericArrays`, old `_numericLU`, old dense `solve`.

### Step 5: Verify and tune

Run all existing tests. Verify performance meets spec targets. Tune pre-allocation sizing if needed.

---

## 9. Performance Targets

From `circuits-engine-spec.md` §3, with 5× CI relaxation:

| n | Symbolic (once) | Numeric factor | Solve | Memory |
|---|----------------|----------------|-------|--------|
| 50 | < 0.5ms (5×) | < 0.25ms (5×) | < 0.1ms (5×) | < 50KB |
| 200 | < 2.5ms (5×) | < 1.0ms (5×) | < 0.5ms (5×) | < 400KB |
| 1000 | < 25ms (5×) | < 10ms (5×) | < 5ms (5×) | < 2.5MB |

The existing `performance_50_node` test thresholds (factor < 2.5ms) should pass comfortably — target is ~0.05ms actual for n=50 with sparse LU.

---

## 10. Tests

All existing tests must continue to pass with identical results:

- `solves_2x2_dense` — unchanged
- `solves_3x3_sparse_tridiagonal` — unchanged
- `sums_duplicate_entries` — unchanged
- `detects_singular_matrix` — unchanged
- `identity_matrix_trivial` — unchanged
- `reuses_symbolic_across_numeric_refactor` — unchanged
- `invalidate_forces_resymbolize` — unchanged
- `mna_resistor_divider_3x3` — unchanged
- `performance_50_node` — should now pass comfortably

### New tests to add

| Test | Purpose |
|------|---------|
| `sparse_lu_fill_in_bounded` | Assert nnz(L) + nnz(U) ≤ 5 × nnz(A) for a banded 50-node matrix. Validates AMD is reducing fill-in. |
| `performance_200_node` | 200-node ~5% density matrix. Factor < 1.0ms, solve < 0.5ms (5× relaxed). |
| `sparse_solve_matches_dense` | For a 20-node random SPD matrix, compare sparse LU solution against a known analytical solution or dense reference. Tolerance 1e-10. |
| `no_allocation_on_refactor` | Assemble, finalize, factor, solve. Change values only (same pattern). Factor + solve again. Assert no new ArrayBuffer allocations between the two factor calls (track via a counter or allocation hook). |

---

## 11. Acceptance Criteria

1. All 9 existing `sparse-solver.test.ts` tests pass with unchanged assertions
2. `performance_50_node` passes comfortably (factor < 2.5ms, actual expected ~0.05ms)
3. New `performance_200_node` test passes
4. No heap allocations on the numeric `factor()` + `solve()` hot path after the first symbolic pass
5. L and U factors stored in sparse CSC format — no dense n×n buffer
6. Memory usage scales as O(nnz) not O(n²)
7. Solution accuracy identical to dense solver (tolerance 1e-10 on all existing tests)
8. Public API (`SparseSolver` class signature) unchanged — no downstream breakage

---

## 12. References

- Tim Davis, "Direct Methods for Sparse Linear Systems", SIAM 2006 — Chapters 4–6
- CSparse source code (public domain): https://people.engr.tamu.edu/davis/suitesparse.html
- CSparse `cs_lu` algorithm — left-looking sparse LU with partial pivoting
- CSparse `cs_etree` — elimination tree computation
- CSparse `cs_reach` — DFS reach for sparse triangular solve
