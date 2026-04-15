# Wave 2 — Matrix Factorization (CRITICAL)

Implementation spec for items 3.1-3.6 from ALIGNMENT-DIFFS.md.

## Current Code Structure

File: `src/solver/analog/sparse-solver.ts`, class `SparseSolver`.

Current factorization path (lines 239-261):
```
factor():
  if _needsReorder:
    rebuild CSC + AMD + symbolic LU
  result = _numericLU()
  if !success && no singularRow:
    rebuild and retry (_numericLU)
  return result
```

Single factorization: `_numericLU()` — left-looking column LU with partial pivoting. Every call does full pivot search (`pinv.fill(-1)` at line 929, pivot search at lines 968-1009).

## Target Code Structure

```typescript
// NEW: preorder() — one-time column/row permutation
preorder(): void {
  if (this._didPreorder) return;
  // SMPpreOrder equivalent: static column permutation
  // For now: no-op if AMD already handles ordering
  this._didPreorder = true;
}

// NEW: factorWithReorder(diagGmin) — full factorization with pivot selection
factorWithReorder(diagGmin?: number): FactorResult {
  // Apply diagGmin to diagonals
  if (diagGmin) this._applyDiagGmin(diagGmin);
  // Full AMD + symbolic + numeric with pivot selection (current _numericLU)
  if (this._needsReorder) {
    this._buildCSC();
    this._computeAMD();
    this._symbolicLU();
    this._needsReorder = false;
  }
  return this._numericLU();  // current impl serves as reorder path
}

// NEW: factorNumerical(diagGmin) — reuse existing pivot order
factorNumerical(diagGmin?: number): FactorResult {
  // Apply diagGmin to diagonals
  if (diagGmin) this._applyDiagGmin(diagGmin);
  // Reuse _pinv[] / _q[] from last factorWithReorder
  // Skip pivot search: use stored column order
  return this._numericLUReusePivots();
}

// NEW: _numericLUReusePivots() — Gaussian elimination only
_numericLUReusePivots(): FactorResult {
  // Same as _numericLU but:
  // - Does NOT call pinv.fill(-1) (keeps existing pivot mapping)
  // - Does NOT search for best pivot (uses stored pinv[col])
  // - If stored pivot gives near-zero value (< PIVOT_ABS_THRESHOLD):
  //   return { success: false } (E_SINGULAR equivalent)
  // - Otherwise: performs elimination using existing pivot order
}
```

## File-by-File Change List

### `src/solver/analog/sparse-solver.ts`

Added:
- `preorder(): void` — one-time permutation, sets `_didPreorder` flag
- `factorWithReorder(diagGmin?: number): FactorResult` — full factorization
- `factorNumerical(diagGmin?: number): FactorResult` — numerical-only, reuses pivots
- `_numericLUReusePivots(): FactorResult` — variant of `_numericLU` without pivot search
- `_applyDiagGmin(diagGmin: number): void` — extracted from current `addDiagonalGmin`
- `_didPreorder: boolean = false`

Changed:
- `factor()` — kept as backward-compatible wrapper:
  ```typescript
  factor(): FactorResult {
    if (this._needsReorder) {
      return this.factorWithReorder();
    }
    return this.factorNumerical();
  }
  ```
- `addDiagonalGmin()` — delegates to `_applyDiagGmin()`, kept for backward compat

### `src/solver/analog/newton-raphson.ts` (Wave 1 coordination)

The NR loop from Wave 1 uses:
```typescript
// Step E in the NR loop:
if (shouldReorder) {
  result = solver.factorWithReorder(diagGmin);
  if (!result.success) return ERROR;  // truly singular
  shouldReorder = false;
} else {
  result = solver.factorNumerical(diagGmin);
  if (!result.success) {
    shouldReorder = true;
    continue;  // back to STEP A (singular retry)
  }
}
```

## Key Implementation Detail: _numericLUReusePivots

The current `_numericLU()` (lines 915-1034) does:
1. `pinv.fill(-1)` — clear all pivot assignments
2. For each column k: search rows for best pivot (Markowitz-like selection)
3. Swap rows, perform elimination

The new `_numericLUReusePivots()` must:
1. **Skip** `pinv.fill(-1)` — keep existing pivot assignments
2. For each column k: use `pinv[k]` directly (no search)
3. If `|L[pinv[k], k]| < PIVOT_ABS_THRESHOLD`: return `{ success: false }` (singular)
4. Perform elimination using the known pivot

This is the key performance optimization: after the first iteration's full factorization, subsequent iterations skip the O(nnz) pivot search per column.

## ngspice Source Mapping

| ngspice | Ours |
|---|---|
| SMPpreOrder (spbuild.c) | `preorder()` |
| spOrderAndFactor (spfactor.c) | `factorWithReorder()` |
| spFactor (spfactor.c) | `factorNumerical()` |
| E_SINGULAR -> NISHOULDREORDER | `factorNumerical` returns `{ success: false }` -> NR loop sets `shouldReorder = true` and continues |
| diagGmin inside factorization | `_applyDiagGmin()` before factor call (both paths) |

## Note on Markowitz

Full Markowitz pivot selection (item 3.4) is a large implementation. The initial implementation uses existing partial-pivoting LU for the reorder path. The key correctness gains are:
1. **Singular retry** (item 3.2) — circuits that previously crashed now get a second chance
2. **Pivot reuse** (item 3.1) — subsequent iterations are faster and more numerically stable
3. **Preorder** (item 3.3) — interface ready for future Markowitz

Markowitz can be added incrementally as a replacement for the pivot search in `_numericLU`.

## Dependency Notes

- Depends on: Wave 1 (NR loop must have `shouldReorder` flag and singular-retry logic)
- Blocks: Waves 4, 7 (DCOP and UIC need correct factorization paths)

## Test Impact

- `sparse-solver.test.ts` — new methods: `factorWithReorder`, `factorNumerical`, `preorder`
- `newton-raphson.test.ts` — singular retry behavior
- `dc-operating-point.test.ts` — gmin stepping uses factor
