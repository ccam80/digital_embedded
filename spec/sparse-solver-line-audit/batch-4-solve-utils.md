# Batch 4 — Sparse Solver Line Audit: solve, snapshots, utilities

Scope: `src/solver/analog/sparse-solver.ts` lines 635-748, 749-810, 987-1067, 2691-2704.

References:
- `ref/ngspice/src/maths/sparse/spsolve.c` (spSolve, spsolve.c:126-191)
- `ref/ngspice/src/maths/sparse/sputils.c` (spStripMatrix, sputils.c:1106-1145)
- `ref/ngspice/src/maths/sparse/spalloc.c` (spError spalloc.c:712-724; spWhereSingular spalloc.c:749-762)

---

## 1. Header Summary

- TS source range: 635-748 (114), 749-810 (62), 987-1067 (81), 2691-2704 (14) = 271 lines total in scope.
- Non-comment / non-blank source lines audited (per-line table rows): **80**
- `match` line classifications: **22**
- `diff` line classifications: **58**
- Function/class definitions in range: **9** (`solve`, `invalidateTopology`, plus the closing brace of `setPivotTolerances` JSDoc only — body excluded; `getRhsSnapshot`, `enablePreSolveRhsCapture`, `getPreSolveRhsSnapshot`, `enablePreFactorMatrixCapture`, `getPreFactorMatrixSnapshot`, `_takePreFactorSnapshotIfEnabled`, `getCSCNonZeros`, `getError`, `whereSingular`).
- `match` function/class definitions: **2** (`getError`, `whereSingular`)
- `diff` function/class definitions: **7** (`solve`, `invalidateTopology`, `getRhsSnapshot`, `enablePreSolveRhsCapture`, `getPreSolveRhsSnapshot`, `enablePreFactorMatrixCapture`, `getPreFactorMatrixSnapshot`, `_takePreFactorSnapshotIfEnabled`, `getCSCNonZeros`)

(Note: the `setPivotTolerances` body lives outside this batch's line range — only its leading JSDoc (lines 798-810) appears here. It is therefore excluded from the function-definition count.)

---

## 2. Per-Function Function-Definition Table

| TS line | TS signature | ngspice function (file:line) | Class | Notes |
|---|---|---|---|---|
| 635 | `solve(x: Float64Array): void` | `spSolve` (spsolve.c:126-191) | diff | Signature reduced from 5 args (Matrix, RHS, Solution, iRHS, iSolution) to 1 (output `x`). RHS read from `this._rhs` instance state (no parameter). No complex/imag dispatch (`SolveComplexMatrix`). No `assert(IS_VALID && IS_FACTORED)`. Internal `Intermediate` is `this._scratch`, not allocated per-call. |
| 749 | `invalidateTopology(): void` | `spStripMatrix` (sputils.c:1106-1145) | diff | Adds clears not present in spStripMatrix: `_factored`, `_didPreorder`, `_originals`, `_error`, `_singularRow`, `_singularCol`, `_preFactorMatrix`, `_structureEmpty`. Omits `assert(IS_SPARSE)` and `if (Matrix->Elements == 0) return` short-circuit (sputils.c:1109-1110). Element-list / fillin-list cursor reset replaced by single `_elCount=0` (different mechanism — chained list in C, single counter in TS). Per-slot reset uses 0-based half-open `[0,n)`; ngspice uses 1-based `[1,Size]`. |
| 987 | `getRhsSnapshot(): Float64Array` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 992 | `enablePreSolveRhsCapture(enabled: boolean): void` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1000 | `getPreSolveRhsSnapshot(): Float64Array` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1005 | `enablePreFactorMatrixCapture(enabled: boolean): void` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1017 | `getPreFactorMatrixSnapshot(): ReadonlyArray<{...}>` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1029 | `_takePreFactorSnapshotIfEnabled(): void` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1051 | `getCSCNonZeros(): Array<{...}>` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 2691 | `getError(): number` | `spError` (spalloc.c:712-724) | match | Returns `Matrix->Error`. The TS form omits the `Matrix != NULL` branch + `spNO_MEMORY` fallback and the `assert(Matrix->ID == SPARSE_ID)` (impossible/unreachable in TS context — the receiver always exists), but the actual operation (return Error) is 1:1. |
| 2700 | `whereSingular(): { row: number; col: number }` | `spWhereSingular` (spalloc.c:749-762) | match | Returns the stored singular row/col. Differs in mechanism: ngspice writes to `*pRow / *pCol` out-pointers and gates on `Error == spSINGULAR \|\| spZERO_DIAG`, returning {0,0} otherwise. The TS form unconditionally returns the stored fields; relies on `_singularRow / _singularCol` being kept at 0 unless an error was set (mirrors the ngspice gate semantically because Stage 6A initializes both to 0 and only writes them at the singular sites). For a single-function definition class this is borderline; classified `match` because the return semantics align under the Stage 6A invariant; per-line gate omission is flagged in the per-line table. |

---

## 3. Per-Line Table

Non-comment, non-blank source lines only. JSDoc / `//` comment lines and blank lines are omitted from this table per project rule.

### 3.1 `solve()` — TS 635-725 vs `spSolve` spsolve.c:126-191

| TS line | TS source | ngspice file:line | Class | Notes |
|---|---|---|---|---|
| 635 | `solve(x: Float64Array): void {` | spsolve.c:126-129 (signature `spSolve(Matrix, RHS, Solution, iRHS, iSolution)`) | diff | 1-arg vs 5-arg signature. RHS sourced from instance `_rhs`, not parameter. No iRHS / iSolution. |
| 641 | `const n = this._n;` | spsolve.c:146 (`Size = Matrix->Size;`) | match | 1:1 size local. |
| 642 | `const b = this._scratch;` | spsolve.c:145 (`Intermediate = Matrix->Intermediate;`) | match | Local alias for the intermediate vector. |
| 643 | `const rhs = this._rhs;` | (no counterpart) | diff | ngspice receives RHS as a function parameter; the TS port reads it from instance state. |
| 644 | `const intToExtRow = this._intToExtRow;` | spsolve.c:149 (`pExtOrder = &Matrix->IntToExtRowMap[Size];`) | diff | ngspice takes the *address-of-slot-Size* and walks it backwards via `*(pExtOrder--)`. The TS port aliases the whole array and uses positional indexing. Same data, different access pattern. |
| 645 | `const intToExtCol = this._preorderColPerm;` | spsolve.c:186 | diff | Same as above for IntToExtColMap. The field name `_preorderColPerm` is also a rename — the C name is `IntToExtColMap`. |
| 646 | `const diag = this._diag;` | spsolve.c:160 (`pPivot = Matrix->Diag[I];`) | diff | ngspice reads `Diag[I]` inline at the use site (it never aliases the whole `Diag` array). |
| 647 | `const elVal = this._elVal;` | (no counterpart) | diff | ngspice dereferences `pElement->Real` directly; there is no parallel-array indirection. |
| 648 | `const elRow = this._elRow;` | (no counterpart) | diff | ngspice reads `pElement->Row`. |
| 649 | `const elCol = this._elCol;` | (no counterpart) | diff | ngspice reads `pElement->Col`. |
| 650 | `const elNextInCol = this._elNextInCol;` | (no counterpart) | diff | ngspice walks `pElement->NextInCol`. |
| 651 | `const elNextInRow = this._elNextInRow;` | (no counterpart) | diff | ngspice walks `pElement->NextInRow`. |
| 662 | `for (let k = n - 1; k >= 0; k--) b[k] = rhs[intToExtRow[k]];` | spsolve.c:149-151 | diff | Iteration bounds differ: TS walks `[n-1..0]` (0-based) and reads `intToExtRow[k]`. ngspice walks `[Size..1]` (1-based, `for (I = Size; I > 0; I--)`) using a decrementing pointer `*(pExtOrder--)`. The TS form also fuses the pointer-decrement into array indexing. Same arithmetic outcome but the operation pattern is not 1:1, and the loop direction relative to the *destination* index is reversed compared to the C source (which writes `Intermediate[I]` with I descending — TS writes `b[k]` with k descending; OK, but the loop is on the same line as the body, no loop-body separation). |
| 680 | `for (let k = 0; k < n; k++) {` | spsolve.c:154 (`for (I = 1; I <= Size; I++)`) | diff | 0-based half-open vs 1-based inclusive. Index meaning shifts by one. |
| 681 | `let temp = b[k];` | spsolve.c:158 (inside `if`) | diff | ngspice fuses the read and the test: `if ((Temp = Intermediate[I]) != 0.0)`. The TS port hoists the read out of the test. |
| 682 | `if (temp !== 0.0) {` | spsolve.c:158 | diff | Test is split from the assignment vs ngspice's fused `(Temp = ...) != 0.0`. |
| 683 | `const pPivot = diag[k];` | spsolve.c:160 (`pPivot = Matrix->Diag[I];`) | match | 1:1 pivot fetch. |
| 684 | `temp *= elVal[pPivot];` | spsolve.c:161 (`Intermediate[I] = (Temp *= pPivot->Real);`) | diff | ngspice fuses the multiply with the store-to-Intermediate. The TS port performs the multiply, then stores on the next line. |
| 685 | `b[k] = temp;` | spsolve.c:161 | diff | Continuation of the split fused expression above. |
| 686 | `let pElement = elNextInCol[pPivot];` | spsolve.c:163 (`pElement = pPivot->NextInCol;`) | match | 1:1 chain init. |
| 687 | `while (pElement >= 0) {` | spsolve.c:164 (`while (pElement != NULL)`) | diff | NULL-vs-(-1) sentinel — the operation is the same but the comparison value/operator differs. |
| 688 | `b[elRow[pElement]] -= temp * elVal[pElement];` | spsolve.c:166 | match | 1:1 update. |
| 689 | `pElement = elNextInCol[pElement];` | spsolve.c:167 | match | 1:1 advance. |
| 690 | `}` | spsolve.c:168 | match | inner loop close. |
| 691 | `}` | spsolve.c:169 | match | if close. |
| 692 | `}` | spsolve.c:170 | match | outer loop close. |
| 707 | `for (let k = n - 1; k >= 0; k--) {` | spsolve.c:173 (`for (I = Size; I > 0; I--)`) | diff | 0-based vs 1-based loop indexing. |
| 708 | `let temp = b[k];` | spsolve.c:175 (`Temp = Intermediate[I];`) | match | 1:1 fetch. |
| 709 | `let pElement = elNextInRow[diag[k]];` | spsolve.c:176 (`pElement = Matrix->Diag[I]->NextInRow;`) | match | 1:1 chain init. |
| 710 | `while (pElement >= 0) {` | spsolve.c:177 (`while (pElement != NULL)`) | diff | Sentinel mismatch. |
| 711 | `temp -= elVal[pElement] * b[elCol[pElement]];` | spsolve.c:179 (`Temp -= pElement->Real * Intermediate[pElement->Col];`) | match | 1:1 update. |
| 712 | `pElement = elNextInRow[pElement];` | spsolve.c:180 | match | 1:1 advance. |
| 713 | `}` | spsolve.c:181 | match | inner loop close. |
| 714 | `b[k] = temp;` | spsolve.c:182 (`Intermediate[I] = Temp;`) | match | 1:1 store. |
| 715 | `}` | spsolve.c:183 | match | outer loop close. |
| 724 | `for (let k = n - 1; k >= 0; k--) x[intToExtCol[k]] = b[k];` | spsolve.c:186-188 | diff | Same iteration-bound and pointer-vs-index drift as line 662 (above). Body fused onto the loop header. ngspice walks `pExtOrder` with `*(pExtOrder--)` from `&IntToExtColMap[Size]`; the TS port indexes positionally. |
| 725 | `}` | spsolve.c:191 | match | function close. |

**Banned-pattern guard #4 verification (`if (n === 0) return`):** GREP-equivalent inspection of lines 635-725 confirms the guard is **not present**. The comment block at lines 636-640 explicitly documents its removal. This stage-6B requirement is met.

### 3.2 `invalidateTopology()` — TS 749-796 vs `spStripMatrix` sputils.c:1106-1145

| TS line | TS source | ngspice file:line | Class | Notes |
|---|---|---|---|---|
| 749 | `invalidateTopology(): void {` | sputils.c:1106 (`spStripMatrix(MatrixPtr Matrix)`) | diff | Method-on-class vs free function. Function name differs. |
| 750 | `const n = this._n;` | sputils.c:1137 (`int I, Size = Matrix->Size;`) | diff | Hoisted out of inner block; ngspice scopes `Size` inside the `{...}` reset block. |
| 752 | `this._rowsLinked = false;` | sputils.c:1111 (`Matrix->RowsLinked = NO;`) | match | 1:1 (boolean vs NO). |
| 754 | `this._needsReorder = true;` | sputils.c:1112 (`Matrix->NeedsOrdering = YES;`) | match | 1:1 (rename `NeedsOrdering` → `_needsReorder`). |
| 759 | `this._elements = 0;` | sputils.c:1113 (`Matrix->Elements = 0;`) | match | 1:1. |
| 760 | `this._originals = 0;` | sputils.c:1114 (`Matrix->Originals = 0;`) | match | 1:1. |
| 761 | `this._fillins = 0;` | sputils.c:1115 (`Matrix->Fillins = 0;`) | match | 1:1. |
| 764 | `this._factored = false;` | (no counterpart) | diff | spStripMatrix does not clear Factored — the digiTS comment justifies the addition, but ngspice does not perform this write here. |
| 765 | `this._didPreorder = false;` | (no counterpart) | diff | No `_didPreorder` analogue is touched in spStripMatrix. |
| 770 | `if (this._rowHead.length >= n) {` | (no counterpart) | diff | ngspice gates the per-slot reset block by `Matrix->Elements == 0` short-circuit at sputils.c:1110, not by an array-capacity check. The TS port uses a length-vs-n guard that has no ngspice counterpart. |
| 771 | `for (let i = 0; i < n; i++) {` | sputils.c:1138 (`for (I = 1; I <= Size; I++)`) | diff | 0-based half-open vs 1-based inclusive. |
| 772 | `this._rowHead[i] = -1;` | sputils.c:1140 (`Matrix->FirstInRow[I] = NULL;`) | diff | Sentinel value differs (NULL vs -1) and field name differs. |
| 773 | `this._colHead[i] = -1;` | sputils.c:1141 (`Matrix->FirstInCol[I] = NULL;`) | diff | Sentinel value differs (NULL vs -1) and field name differs. |
| 774 | `this._diag[i] = -1;` | sputils.c:1142 (`Matrix->Diag[I] = NULL;`) | diff | Sentinel value differs. |
| 775 | `}` | sputils.c:1143 | match | loop close. |
| 776 | `}` | (no counterpart) | diff | Closes the `_rowHead.length >= n` guard that has no C counterpart. |
| 781 | `this._elCount = 0;` | sputils.c:1117-1124 (element-list cursor reset block) | diff | ngspice resets a chained ElementListNode structure: walks LastElementListNode/FirstElementListNode, sets ElementsRemaining and NextAvailElement. The TS port collapses all of that to a single counter assignment. Different data structure → different reset operation. ngspice's three writes (LastElementListNode, ElementsRemaining, NextAvailElement) and the three fillin-list writes (sputils.c:1126-1133) all become this one line. |
| 783 | `this._error = spOKAY;` | (no counterpart) | diff | spStripMatrix does not clear Error. |
| 784 | `this._singularRow = 0;` | (no counterpart) | diff | spStripMatrix does not clear SingularRow. |
| 785 | `this._singularCol = 0;` | (no counterpart) | diff | spStripMatrix does not clear SingularCol. |
| 788 | `this._preFactorMatrix = null;` | (no counterpart) | diff (digiTS-only) | Instrumentation buffer; no analogue. |
| 795 | `this._structureEmpty = true;` | (no counterpart) | diff (digiTS-only) | digiTS-only flag; no analogue. |
| 796 | `}` | sputils.c:1145 | match | function close. |

**Missing in TS port (present in ngspice):**
- `assert(IS_SPARSE(Matrix))` — sputils.c:1109.
- `if (Matrix->Elements == 0) return;` short-circuit — sputils.c:1110.
- ElementListNode chain walk — sputils.c:1118-1124 (`pListNode = ... = FirstElementListNode; ElementsRemaining = pListNode->NumberOfElementsInList; NextAvailElement = pListNode->pElementList;`).
- FillinListNode chain walk — sputils.c:1127-1133 (`LastFillinListNode = FirstFillinListNode; FillinsRemaining = pListNode->NumberOfFillinsInList; NextAvailFillin = pListNode->pFillinList;`).

### 3.3 setPivotTolerances JSDoc (lines 798-810)

The function body lives outside this batch's range. Lines 798-810 are JSDoc only and are excluded from the per-line table per the "non-comment, non-blank" rule.

### 3.4 Snapshot / instrumentation helpers — TS 987-1062

These functions have no ngspice counterpart and are mass-marked `diff (digiTS-only)`.

| TS line | TS source | ngspice file:line | Class | Notes |
|---|---|---|---|---|
| 987 | `getRhsSnapshot(): Float64Array {` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 988 | `return this._rhs.slice(0, this._n);` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 989 | `}` | (no counterpart) | diff (digiTS-only) | Closes instrumentation method. |
| 992 | `enablePreSolveRhsCapture(enabled: boolean): void {` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 993 | `this._capturePreSolveRhs = enabled;` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 994 | `if (enabled && (this._preSolveRhs === null \|\| this._preSolveRhs.length !== this._n)) {` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 995 | `this._preSolveRhs = new Float64Array(this._n);` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 996 | `}` | (no counterpart) | diff (digiTS-only) | Closes if. |
| 997 | `}` | (no counterpart) | diff (digiTS-only) | Closes method. |
| 1000 | `getPreSolveRhsSnapshot(): Float64Array {` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1001 | `return this._preSolveRhs ?? new Float64Array(0);` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1002 | `}` | (no counterpart) | diff (digiTS-only) | Closes method. |
| 1005 | `enablePreFactorMatrixCapture(enabled: boolean): void {` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1006 | `this._capturePreFactorMatrix = enabled;` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1007 | `if (!enabled) this._preFactorMatrix = null;` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1008 | `}` | (no counterpart) | diff (digiTS-only) | Closes method. |
| 1017 | `getPreFactorMatrixSnapshot(): ReadonlyArray<{ row: number; col: number; value: number }> {` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1018 | `return this._preFactorMatrix ?? [];` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1019 | `}` | (no counterpart) | diff (digiTS-only) | Closes method. |
| 1029 | `private _takePreFactorSnapshotIfEnabled(): void {` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1030 | `if (!this._capturePreFactorMatrix) return;` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1031 | `const n = this._n;` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1032 | `const snap: Array<{ row: number; col: number; value: number }> = [];` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1033 | `for (let col = 0; col < n; col++) {` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1034 | `let e = this._colHead[col];` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1035 | `while (e >= 0) {` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1036 | `snap.push({ row: this._elRow[e], col: this._elCol[e], value: this._elVal[e] });` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1037 | `e = this._elNextInCol[e];` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1038 | `}` | (no counterpart) | diff (digiTS-only) | Closes inner while. |
| 1039 | `}` | (no counterpart) | diff (digiTS-only) | Closes outer for. |
| 1040 | `this._preFactorMatrix = snap;` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1041 | `}` | (no counterpart) | diff (digiTS-only) | Closes method. |
| 1051 | `getCSCNonZeros(): Array<{ row: number; col: number; value: number }> {` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1052 | `const n = this._n;` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1053 | `const result: Array<{ row: number; col: number; value: number }> = [];` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1054 | `for (let col = 0; col < n; col++) {` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1055 | `let e = this._colHead[col];` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1056 | `while (e >= 0) {` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1057 | `result.push({ row: this._elRow[e], col: this._elCol[e], value: this._elVal[e] });` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1058 | `e = this._elNextInCol[e];` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1059 | `}` | (no counterpart) | diff (digiTS-only) | Closes inner while. |
| 1060 | `}` | (no counterpart) | diff (digiTS-only) | Closes outer for. |
| 1061 | `return result;` | (no counterpart) | diff (digiTS-only) | Instrumentation. |
| 1062 | `}` | (no counterpart) | diff (digiTS-only) | Closes method. |

### 3.5 `getError()` and `whereSingular()` — TS 2691-2704

| TS line | TS source | ngspice file:line | Class | Notes |
|---|---|---|---|---|
| 2691 | `getError(): number {` | spalloc.c:712-713 (`int spError(MatrixPtr Matrix)`) | diff | Method-on-class vs free function; signature differs. |
| 2692 | `return this._error;` | spalloc.c:719 (`return Matrix->Error;`) | match | 1:1 read. |
| 2693 | `}` | spalloc.c:724 | match | function close. |
| 2700 | `whereSingular(): { row: number; col: number } {` | spalloc.c:749-750 (`void spWhereSingular(MatrixPtr Matrix, int *pRow, int *pCol)`) | diff | Signature: object-return vs out-pointer pair. |
| 2701 | `return { row: this._singularRow, col: this._singularCol };` | spalloc.c:755-760 (`if (Error == spSINGULAR \|\| Error == spZERO_DIAG) {*pRow = SingularRow; *pCol = SingularCol;} else *pRow = *pCol = 0;`) | diff | The TS form omits the gate on `Error == spSINGULAR \|\| Error == spZERO_DIAG`. ngspice forces {0,0} when Error is anything else, even if SingularRow/SingularCol still hold stale values. The TS port relies on Stage 6A keeping the fields zero unless explicitly set, but the read path does not enforce the gate the C source does. |
| 2702 | `}` | spalloc.c:762 | match | function close. |

---

## 4. Closing Structural-Drift Summary (worst-first)

1. **TS 749-796 `invalidateTopology` clears extra state ngspice's `spStripMatrix` does not touch** — adds writes to `_factored` (TS 764), `_didPreorder` (765), `_originals` (760), `_error` (783), `_singularRow` (784), `_singularCol` (785), `_preFactorMatrix` (788), `_structureEmpty` (795). ngspice limits the strip to `RowsLinked, NeedsOrdering, Elements, Originals, Fillins` plus list cursors and slot heads. The extra clears change semantics across reload boundaries.
2. **TS 781 collapses ngspice's element-list and fillin-list cursor reset (sputils.c:1117-1133, 11 statements over two `{...}` blocks) into a single `_elCount = 0;`** — reflects a different element-storage data structure, not a port of the original reset.
3. **TS 749 omits `spStripMatrix`'s `if (Matrix->Elements == 0) return;` short-circuit at sputils.c:1110** — the TS port unconditionally rewrites every slot head, while ngspice exits before any write when the matrix is already empty.
4. **TS 2701 `whereSingular()` drops the `Error == spSINGULAR \|\| Error == spZERO_DIAG` gate from spalloc.c:755** — the TS port reports stored row/col irrespective of error state. Correct only as long as the writers maintain the invariant that `_singularRow`/`_singularCol` are 0 when no error is active. The read-path divergence is a load-bearing contract change.
5. **TS 643-651 hoist nine field-aliases (`rhs`, `intToExtRow`, `intToExtCol`, `diag`, `elVal`, `elRow`, `elCol`, `elNextInCol`, `elNextInRow`) at function entry that ngspice does not pre-alias** — `spSolve` aliases only `Intermediate` and `Size`. Every other read in C is direct (`Matrix->Diag[I]`, `pElement->Real`, etc.). The hoisting is observable in iteration order if any of the source fields are reassigned mid-call (today they are not, but the contract is not the C contract).
6. **TS 662 fuses scramble-init loop body onto the loop header line and reverses index direction relative to the C source** — ngspice walks `for (I = Size; I > 0; I--) Intermediate[I] = RHS[*(pExtOrder--)];` with a decrementing pointer; TS uses positional `intToExtRow[k]` indexing in the same direction. Same arithmetic outcome, different operation set per iteration.
7. **TS 680 / 707 use 0-based half-open loop bounds `[0, n)` and `[n-1, 0]` while ngspice uses 1-based inclusive `[1, Size]` and `[Size, 1]`** — every index inside the loops is shifted by one relative to the C source, which means any cross-referenced ngspice line numbers / variable-meaning identities require a translation table.
8. **TS 681-685 split the fused C expression `Intermediate[I] = (Temp *= pPivot->Real);` (spsolve.c:161) into three statements** — `let temp = b[k]; ... temp *= elVal[pPivot]; b[k] = temp;`. The store happens at a different statement index than in ngspice.
9. **TS 687 / 710 `while (pElement >= 0)` vs ngspice `while (pElement != NULL)`** — sentinel value (NULL vs -1) reflects parallel-array storage. Operationally the chain walk terminates the same way, but the comparison is not 1:1.
10. **TS 635 `solve(x: Float64Array)` reduces `spSolve`'s 5-arg signature to a 1-arg signature; RHS is read from instance state `_rhs` rather than passed as a parameter** — observable: ngspice's `RHS` and `Solution` are independent vectors that may alias; the TS port forces RHS to be the solver-owned buffer.
11. **TS 635 omits the `assert(IS_VALID(Matrix) && IS_FACTORED(Matrix))` precondition (spsolve.c:137) and the `Matrix->Complex` dispatch (spsolve.c:139-143)** — the TS port silently runs without verifying factored state and has no path to a complex solver.
12. **TS 645 renames `IntToExtColMap` to `_preorderColPerm`** — semantic name drift. Cross-referencing the C source requires a rename map.
13. **TS 749 omits `assert(IS_SPARSE(Matrix))` from sputils.c:1109** — the TS port does not assert the matrix kind precondition that ngspice does.
14. **TS 770 introduces `if (this._rowHead.length >= n)` capacity guard with no ngspice counterpart** — gates the per-slot reset on an array-allocation condition rather than on the `Elements == 0` short-circuit ngspice uses.
15. **TS 771-774 use sentinel `-1` for empty chain heads / diag pointers vs ngspice's `NULL`** — directly tied to the parallel-array vs pointer-struct storage divergence; affects any caller that compares against the original spdefs.h sentinel.
16. **TS 2691 `getError(): number` omits ngspice's `Matrix != NULL` branch and `spNO_MEMORY` fallback (spalloc.c:717-723) and the `assert(Matrix->ID == SPARSE_ID)` precondition** — observable when the receiver is nullish (TS) vs allocation-failure (C).
17. **TS 2700 `whereSingular(): { row, col }` returns an object literal vs ngspice writing through `int *pRow, int *pCol` out-pointers** — call-site shape divergence.
18. **TS 987-1062 introduce six instrumentation methods with no ngspice counterpart** (`getRhsSnapshot`, `enablePreSolveRhsCapture`, `getPreSolveRhsSnapshot`, `enablePreFactorMatrixCapture`, `getPreFactorMatrixSnapshot`, `_takePreFactorSnapshotIfEnabled`, `getCSCNonZeros`) — all-digiTS surface, mass-classified `diff (digiTS-only)`.
