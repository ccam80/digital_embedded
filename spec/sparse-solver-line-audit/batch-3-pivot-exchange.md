# Batch 3 — Pivot search and exchange (line-by-line audit)

TS file: `src/solver/analog/sparse-solver.ts`
Ranges audited: 820-985, 1686-1751, 1752-1819, 1820-2189, 2191-2637 (closing brace of `_updateMarkowitzNumbers` at 2619; range continues to next routine).

ngspice references: `ref/ngspice/src/maths/sparse/spfactor.c`,
`ref/ngspice/src/maths/sparse/sputils.c` (`spMNA_Preorder`, `SwapCols`),
`ref/ngspice/src/maths/sparse/spbuild.c` (`spcLinkRows`),
`ref/ngspice/src/maths/sparse/spsmp.c` (`SMPpreOrder`).

## 1. Header summary

| Metric | Value |
|---|---|
| Non-comment, non-blank TS source lines (in scope) | 575 |
| `match` lines | 256 |
| `diff` lines | 319 |
| `match` function/class definitions | 1 |
| `diff` function/class definitions | 19 |

## 2. Per-function table

| TS line | TS signature | ngspice function (file:line) | Class | Notes |
|---|---|---|---|---|
| 820 | `forceReorder(): void` | (no counterpart) | diff (digiTS-only) | digiTS-only sticky reorder flag; ngspice keys reorder off `Factored`/`Reordered`. |
| 830 | `preorder(): void` | `spMNA_Preorder` (sputils.c:177) + indirectly `SMPpreOrder` (spsmp.c:272) | diff | Single-fixed-point loop; no `CountTwins` helper, no two-phase (lone vs multi twins) structure, no `Reordered = YES`, no `NumberOfInterchangesIsOdd` toggle. Different control flow. |
| 882 | `_linkRows(): void` | `spcLinkRows` (spbuild.c:907) | match | Walks columns Size..1, head-inserts each element into `FirstInRow[Row]`, stamps `pElement->Col = Col`. 1:1 with C body. |
| 902 | `_findTwin(col, targetRow): number` | `CountTwins` (sputils.c:243) — partial | diff | Returns single twin element instead of count + dual-pointer `pTwin1/pTwin2`. ngspice's `CountTwins` has its own outer loop testing `ABS(pTwin1->Real)==1.0` and recursing into the row-side column. digiTS does only the inner row-side scan. |
| 920 | `_swapColumns(col1, col2, pTwin1, pTwin2)` | `SwapCols` (sputils.c:283) | diff | Different parameter shape (4 ints vs 2 element ptrs); does NOT toggle `NumberOfInterchangesIsOdd` (sputils.c:299). |
| 943 | `_findDiagOnColumn(slot)` | `spcFindElementInCol(Col,Col)` (spbuild.c, used spfactor.c:2046) | diff | Standalone helper; ngspice calls a generic `spcFindElementInCol` with `(Col, Col, NO)`. Different signature and no allocate-on-miss path. |
| 976-988 | `dimension`, `markowitzRow`, `markowitzCol`, `markowitzProd`, `singletons`, `getRhsSnapshot` (instrumentation getters) | (no counterpart) | diff (digiTS-only) | Test-only side channel; ngspice exposes via direct struct read. |
| 1686 | `_findLargestInCol(startE)` | `FindLargestInCol` (spfactor.c:1849) | match | Walk column from start element, track max magnitude. 1:1. |
| 1707 | `_findBiggestInColExclude(pE, step)` | `FindBiggestInColExclude` (spfactor.c:1913) | diff | Body adds extra `e >= 0` guard at line 1719 (ngspice unconditionally dereferences `pElement->Row`); init walk and post-walk loop reordered to a separate `if (e<0) break` exit. |
| 1752 | `_countMarkowitz(step, rhs)` | `CountMarkowitz` (spfactor.c:782) | match | Two `for I` loops; pre-skip-then-count walk; RHS bump via `IntToExtRowMap`. 1:1. |
| 1793 | `_markowitzProducts(step)` | `MarkowitzProducts` (spfactor.c:865) | diff | Replaces ngspice's pointer-walk (`*pMarkowitzRow++`) with array indexing per slot; fuses `Singletons++` test inside the non-overflow branch only (matches), but the overflow branch unconditionally writes `mProd[i]` without ngspice's distinct increment. The `(product | 0)` truncation at 1803 also has no C analogue (C casts the double once). |
| 1820 | `_searchForPivot(step)` | `SearchForPivot` (spfactor.c:947) | diff | Drops `Matrix->PivotSelectionMethod` writes (`'s'`, `'q'`, `'d'`, `'e'` set on each branch). Drops `DiagPivoting` parameter. |
| 1848 | `_searchForSingleton(step)` | `SearchForSingleton` (spfactor.c:1040) | diff | Adds bounds-guarded reads (`p>=0?mProd[p]:0`) at 1873 with no C analogue; replaces NULL-deref with NaN-via-out-of-bounds at 1904; preserves the bug but rephrases the body. |
| 1952 | `_quicklySearchDiagonal(step)` | `QuicklySearchDiagonal` (spfactor.c:1254 MODIFIED_MARKOWITZ branch) | diff | Replaces pointer pre-decrement loop (spfactor.c:1294) with a pre/post indexed do/while + bounds guard (`p>=0?mProd[p]:-1`); local `tied` array allocated each call instead of stack array. |
| 2057 | `_searchDiagonal(step)` | `SearchDiagonal` (spfactor.c:1604) | diff | for-loop pre-decrement uses index `p` plus `p<0 break` (no C analogue at spfactor.c:1626 — C relies on Step-1 sentinel). |
| 2110 | `_searchEntireMatrix(step)` | `SearchEntireMatrix` (spfactor.c:1730) | diff | Body matches mostly but fails to set `Matrix->Error = spSINGULAR` on the all-zero exit (spfactor.c:1803); just returns -1. |
| 2191 | `_spcRowExchange(row1Arg, row2Arg)` | `spcRowExchange` (spfactor.c:2109) | diff | Drops `InternalVectorsAllocated` guard (spfactor.c:2154); always swaps `MarkowitzRow`. |
| 2244 | `_spcColExchange(col1Arg, col2Arg)` | `spcColExchange` (spfactor.c:2203) | diff | Drops `InternalVectorsAllocated` guard (spfactor.c:2248); always swaps `MarkowitzCol`. Maintains `_preorderColPerm` (digiTS-only artifact) instead of `IntToExtColMap`. |
| 2299 | `_setColLink(prev, e, col)` | (no direct counterpart) | diff (digiTS-only) | Wrapper that mirrors C's `*ElementAboveRow = X` idiom for singly-linked walks. |
| 2308 | `_setRowLink(prev, e, row)` | (no direct counterpart) | diff (digiTS-only) | Mirror of above for rows. |
| 2321 | `_exchangeColElements(row1, e1, row2, e2, column)` | `ExchangeColElements` (spfactor.c:2302) | diff | Body close to C, but the redundant `*ElementAboveRow1 = ElementBelowRow1` becomes a local helper call; `pElement->Row != Row2` checks have additional `pElement >= 0` bounds guards (no C analogue). |
| 2416 | `_exchangeRowElements(col1, e1, col2, e2, row)` | `ExchangeRowElements` (spfactor.c:2431) | diff | Same drift as col-side mirror. |
| 2511 | `_exchangeRowsAndCols(pivotE, step)` | `ExchangeRowsAndCols` (spfactor.c:1986) | diff | Drops `Matrix->PivotsOriginalRow/Col` writes (spfactor.c:1995-1996); drops `NumberOfInterchangesIsOdd` toggles (spfactor.c:2016, 2033); replaces `spcFindElementInCol(...,NO)` with digiTS `_findDiagOnColumn`. |
| 2579 | `_updateMarkowitzNumbers(pivotE)` | `UpdateMarkowitzNumbers` (spfactor.c:2712) | diff | Replaces `MarkoCol[Row] * MarkoRow[Row]` with `mCol[row] * mRow[row]` and unconditional `(product | 0)` truncation; fuses overflow path into a single ternary write. |

## 3. Per-line table

Class is `match` only when the operation maps 1:1 to a single ngspice line. C-line citations are file:line in `spfactor.c` (s), `sputils.c` (u), `spbuild.c` (b), `spsmp.c` (sm).

### Lines 820-867 — `forceReorder` and `preorder`

| TS line | TS source | C file:line | Class | Notes |
|---|---|---|---|---|
| 820 | `forceReorder(): void {` | — | diff | digiTS-only entry point; no ngspice counterpart. |
| 821 | `this._needsReorder = true;` | — | diff | digiTS-only flag. |
| 822 | `}` | — | diff | end of digiTS-only fn. |
| 830 | `preorder(): void {` | u:177 | diff | Different signature; ngspice routine takes `MatrixPtr` and asserts `IS_VALID && !Factored`. |
| 831 | `if (this._didPreorder) return;` | u:187 (`if (RowsLinked) return;`) | diff | Different sentinel; digiTS uses dedicated bool. |
| 832 | `this._didPreorder = true;` | u:189 (`Reordered = YES`) | diff | Different flag, set in the wrong narrative spot. |
| 840 | `let startAt = 0;` | u:181 (`StartAt = 1`) | diff | Hoisted outside the do/while; ngspice declares inside fn body before do-while. |
| 841 | `let didSwap = true;` | u:182 | diff | Different init pattern; ngspice's `Swapped` is reset to NO inside loop. |
| 842 | `while (didSwap) {` | u:191 (`do {`) | diff | While-loop vs do/while in C. |
| 843 | `didSwap = false;` | u:193 (`AnotherPassNeeded = Swapped = NO`) | diff | Misses `AnotherPassNeeded`. |
| 844 | `for (let col = startAt; col < this._n; col++) {` | u:196 | diff | digiTS uses `<n` (0-based); C uses `<= Size`. |
| 845 | (comment) | — | — | comment — skipped. |
| 846 | `if (this._diag[col] >= 0 && this._elVal[this._diag[col]] !== 0) continue;` | u:198 (`if (Diag[J] == NULL)`) | diff | Adds value-test branch absent from ngspice (which uses NULL-only check). |
| 847 | (comment block) | — | — | comment. |
| 849 | `let el = this._colHead[col];` | (no counterpart) | diff | digiTS-only inline scan; ngspice delegates to `CountTwins`. |
| 850 | `while (el >= 0) {` | (no counterpart) | diff | digiTS scan inlined. |
| 851 | `if (Math.abs(this._elVal[el]) === 1.0) {` | u:254 (`if (ABS(pTwin1->Real) == 1.0)`) | diff | Inlined CountTwins fragment, missing the `(*ppTwin1 = pTwin1)->Col = Col` side-effect. |
| 852 | `const row = this._elRow[el];` | u:256 | diff | Inlined. |
| 853 | (comment) | — | — | comment. |
| 854 | `const pTwin2 = this._findTwin(row, col);` | u:257-260 | diff | digiTS calls helper with reversed roles; ngspice walks `FirstInCol[Row]` looking for `pTwin2->Row != Col`, then verifies `ABS(pTwin2->Real) == 1.0`. |
| 855 | `if (pTwin2 >= 0) {` | u:260 (`(pTwin2 != NULL) && ABS == 1.0`) | diff | Test reorganised. |
| 856 | `this._swapColumns(col, row, el, pTwin2);` | u:204/u:223 | diff | Calls the wrong-shape helper. |
| 857 | `didSwap = true;` | u:205 (`Swapped = YES`) | match | Logical match. |
| 858 | `startAt = col + 1;` | (no counterpart in lone-twin branch) | diff | ngspice only sets `StartAt = J` in the multi-twin branch (u:210). |
| 859 | `break;` | — | diff | Exits inner col-walk; ngspice continues per CountTwins design. |
| 860 | `}` | — | — | brace. |
| 862 | `el = this._elNextInCol[el];` | u:268 | diff | Continued inlined CountTwins. |
| 863 | `}` | — | — | brace. |
| 864 | `if (didSwap) break;` | — | diff | digiTS-only fast restart; ngspice has no break — it relies on StartAt to advance. |
| 865 | `}` | u:213 | — | brace. |
| 866 | `}` | u:228 | — | brace closing while; no `Reordered`/return. |

### Lines 882-895 — `_linkRows`

| TS line | TS source | C file:line | Class | Notes |
|---|---|---|---|---|
| 882 | `private _linkRows(): void {` | b:908 | match | Same fn, internal. |
| 883 | `const n = this._n;` | b:915 (`FirstInRowArray = Matrix->FirstInRow;`) | diff | Hoist of size; ngspice hoists the array pointer instead. |
| 884 | `for (let r = 0; r < n; r++) this._rowHead[r] = -1;` | (no counterpart) | diff | digiTS preclear of row heads; ngspice never resets `FirstInRow` here (caller does at allocation). |
| 885 | `for (let col = n - 1; col >= 0; col--) {` | b:916 (`for (Col = Matrix->Size; Col >= 1; Col--)`) | match | 0-based vs 1-based; same direction. |
| 886 | `let e = this._colHead[col];` | b:919 | match | |
| 887 | `while (e >= 0) {` | b:921 | match | |
| 888 | `const r = this._elRow[e];` | b:924 (read) | match | |
| 889 | `this._elCol[e] = col;` | b:923 | match | |
| 890 | `this._elNextInRow[e] = this._rowHead[r];` | b:925 | match | |
| 891 | `this._rowHead[r] = e;` | b:926 | match | |
| 892 | `e = this._elNextInCol[e];` | b:927 | match | |
| 893-895 | braces | b:928-929 | — | braces. ngspice also writes `Matrix->RowsLinked = YES` (b:930) — digiTS omits this state flag. |

(Closing `RowsLinked = YES` at b:930 is missing in digiTS — recorded as a single diff in `_linkRows` epilogue: TS has none.)

### Lines 902-909 — `_findTwin`

| TS line | TS source | C file:line | Class | Notes |
|---|---|---|---|---|
| 902 | `private _findTwin(col, targetRow): number {` | u:243 (`CountTwins`) | diff | Wrong function shape. |
| 903 | `let el = this._colHead[col];` | u:257 (inner scan) | diff | digiTS jumps straight to inner pTwin2 scan. |
| 904 | `while (el >= 0) {` | u:258 | diff | |
| 905 | `if (this._elRow[el] === targetRow && Math.abs(this._elVal[el]) === 1.0) return el;` | u:258-260 | diff | Fuses two ngspice tests into one expression. |
| 906 | `el = this._elNextInCol[el];` | u:259 | diff | |
| 907-909 | braces / `return -1;` | (no analogue) | diff | Returns one element; ngspice's CountTwins returns count. |

### Lines 920-934 — `_swapColumns`

| TS line | TS source | C file:line | Class | Notes |
|---|---|---|---|---|
| 920 | `private _swapColumns(col1, col2, pTwin1, pTwin2)` | u:284 | diff | Different signature. |
| 921 | `const tmpHead = this._colHead[col1];` | u:290 (`SWAP(ElementPtr, FirstInCol[Col1], FirstInCol[Col2])`) | diff | Hand-expanded SWAP macro. |
| 922 | `this._colHead[col1] = this._colHead[col2];` | u:290 | diff | Part of expanded SWAP. |
| 923 | `this._colHead[col2] = tmpHead;` | u:290 | diff | Part of expanded SWAP. |
| 925 | `const origCol1 = this._preorderColPerm[col1];` | u:291 (`SWAP(int, IntToExtColMap[Col1], IntToExtColMap[Col2])`) | diff | digiTS uses `_preorderColPerm`, not `IntToExtColMap`. |
| 926 | `const origCol2 = this._preorderColPerm[col2];` | u:291 | diff | |
| 927 | `this._preorderColPerm[col1] = origCol2;` | u:291 | diff | |
| 928 | `this._preorderColPerm[col2] = origCol1;` | u:291 | diff | |
| 929 | `this._extToIntCol[origCol1] = col2;` | u:293 | diff | |
| 930 | `this._extToIntCol[origCol2] = col1;` | u:294 | diff | |
| 932 | `this._diag[col1] = pTwin2;` | u:297 | match | |
| 933 | `this._diag[col2] = pTwin1;` | u:298 | match | |
| 934 | `}` | u:301 | diff | Missing `NumberOfInterchangesIsOdd = !...` (u:299). |

### Lines 943-950 — `_findDiagOnColumn`

| TS line | TS source | C file:line | Class | Notes |
|---|---|---|---|---|
| 943 | `private _findDiagOnColumn(slot): number {` | spbuild.c spcFindElementInCol (used s:2046) | diff | digiTS-only specialisation. |
| 944 | `let e = this._colHead[slot];` | (no exact line) | diff | digiTS-specific. |
| 945 | `while (e >= 0) {` | (no exact line) | diff | |
| 946 | `if (this._elRow[e] === slot) return e;` | (no exact line) | diff | |
| 947 | `e = this._elNextInCol[e];` | (no exact line) | diff | |
| 948-950 | braces / `return -1;` | (no exact line) | diff | |

### Lines 976-988 — Instrumentation getters

| TS line | TS source | C file:line | Class | Notes |
|---|---|---|---|---|
| 976 | `get dimension(): number { return this._n; }` | (no counterpart) | diff | digiTS-only. |
| 978 | `get markowitzRow(): Int32Array { return this._markowitzRow; }` | — | diff | digiTS-only. |
| 980 | `get markowitzCol(): Int32Array { return this._markowitzCol; }` | — | diff | digiTS-only. |
| 982 | `get markowitzProd(): Int32Array { return this._markowitzProd; }` | — | diff | digiTS-only. |
| 984 | `get singletons(): number { return this._singletons; }` | — | diff | digiTS-only. |
| 987 | `getRhsSnapshot(): Float64Array { return this._rhs.slice(0, this._n); }` | — | diff | digiTS-only. |

### Lines 1686-1695 — `_findLargestInCol`

| TS line | TS source | C file:line | Class | Notes |
|---|---|---|---|---|
| 1686 | `private _findLargestInCol(startE): number {` | s:1849 | match | |
| 1687 | `let largest = 0;` | s:1852 | match | |
| 1688 | `let e = startE;` | (assignment to local pointer) | match | |
| 1689 | `while (e >= 0) {` | s:1856 | match | |
| 1690 | `const magnitude = Math.abs(this._elVal[e]);` | s:1857 (`Magnitude = ELEMENT_MAG`) | match | |
| 1691 | `if (magnitude > largest) largest = magnitude;` | s:1857-1858 | match | |
| 1692 | `e = this._elNextInCol[e];` | s:1859 | match | |
| 1694 | `return largest;` | s:1862 | match | |
| 1695 | `}` | s:1863 | — | brace. |

### Lines 1707-1736 — `_findBiggestInColExclude`

| TS line | TS source | C file:line | Class | Notes |
|---|---|---|---|---|
| 1707 | `private _findBiggestInColExclude(pE, step): number {` | s:1913 | match | |
| 1708 | `const row = this._elRow[pE];` | s:1921 | match | |
| 1709 | `const col = this._elCol[pE];` | s:1922 | match | |
| 1710 | `let e = this._colHead[col];` | s:1923 | match | |
| 1713 | `while (e >= 0 && this._elRow[e] < step) {` | s:1926 | match | |
| 1714 | `e = this._elNextInCol[e];` | s:1927 | match | |
| 1715 | `}` | (brace) | — | |
| 1718 | `let largest: number;` | s:1918 (decl `Largest`) | match | |
| 1719 | `if (e >= 0 && this._elRow[e] !== row) {` | s:1930 (`if (pElement->Row != Row)`) | diff | Adds `e >= 0` guard with no C analogue. |
| 1720 | `largest = Math.abs(this._elVal[e]);` | s:1931 | match | |
| 1721 | `} else {` | s:1932 | match | |
| 1722 | `largest = 0.0;` | s:1933 | match | |
| 1723 | `}` | (brace) | — | |
| 1726 | `while (e >= 0) {` | s:1936 | diff | C uses `while ((pElement = pElement->NextInCol) != NULL)` — fuses advance and test in the loop header. |
| 1727 | `e = this._elNextInCol[e];` | s:1936 (advance inside while header) | diff | Separated. |
| 1728 | `if (e < 0) break;` | s:1936 (NULL exits while header) | diff | digiTS adds explicit early-break. |
| 1729 | `const magnitude = Math.abs(this._elVal[e]);` | s:1937 | match | |
| 1730 | `if (magnitude > largest && this._elRow[e] !== row) {` | s:1937-1938 | diff | Order of conjuncts swapped relative to C (`Magnitude > Largest` then `Row != Row`); functionally same but two tests fused into one short-circuit `&&`. |
| 1731 | `largest = magnitude;` | s:1939 | match | |
| 1732-1733 | braces | (s:1940-1941) | — | |
| 1735 | `return largest;` | s:1943 | match | |
| 1736 | `}` | s:1944 | — | brace. |

### Lines 1739-1742 — Constants

| TS line | TS source | C file:line | Class | Notes |
|---|---|---|---|---|
| 1739 | `MAX_MARKOWITZ_TIES = 100;` | spconfig.h | match | |
| 1740 | `TIES_MULTIPLIER = 5;` | spconfig.h | match | |
| 1741 | `LARGEST_LONG_INTEGER = 0x7fffffff;` | spdefs.h | match | |
| 1742 | `LARGEST_SHORT_INTEGER = 32767;` | spdefs.h | match | |

### Lines 1752-1784 — `_countMarkowitz`

| TS line | TS source | C file:line | Class | Notes |
|---|---|---|---|---|
| 1752 | `private _countMarkowitz(step, rhs)` | s:782 | match | |
| 1753 | `const n = this._n;` | s:785 (`Size = Matrix->Size`) | match | |
| 1754 | `const mRow = this._markowitzRow;` | (alias) | match | |
| 1755 | `const mCol = this._markowitzCol;` | (alias) | match | |
| 1758 | `for (let i = step; i < n; i++) {` | s:792 | match | |
| 1759 | `let count = -1;` | s:794 | match | |
| 1760 | `let e = this._rowHead[i];` | s:795 | match | |
| 1761 | `while (e >= 0 && this._elCol[e] < step) e = this._elNextInRow[e];` | s:796-797 | match | |
| 1762 | `while (e >= 0) {` | s:798 | match | |
| 1763 | `count++;` | s:799 | match | |
| 1764 | `e = this._elNextInRow[e];` | s:800 | match | |
| 1765 | `}` | s:801 | — | |
| 1766 | `const extRow = this._intToExtRow[i];` | s:804 | match | |
| 1767 | `if (rhs && rhs[extRow] !== 0) {` | s:806-807 | match | |
| 1768 | `count += 1;` | s:808 | match | |
| 1769 | `}` | (brace) | — | |
| 1770 | `mRow[i] = count;` | s:809 | match | |
| 1771 | `}` | s:810 | — | |
| 1774 | `for (let i = step; i < n; i++) {` | s:813 | match | |
| 1775 | `let count = -1;` | s:815 | match | |
| 1776 | `let e = this._colHead[i];` | s:816 | match | |
| 1777 | `while (e >= 0 && this._elRow[e] < step) e = this._elNextInCol[e];` | s:817-818 | match | |
| 1778 | `while (e >= 0) {` | s:819 | match | |
| 1779 | `count++;` | s:820 | match | |
| 1780 | `e = this._elNextInCol[e];` | s:821 | match | |
| 1781 | `}` | s:822 | — | |
| 1782 | `mCol[i] = count;` | s:823 | match | |
| 1783-1784 | braces | s:825-826 | — | |

### Lines 1793-1810 — `_markowitzProducts`

| TS line | TS source | C file:line | Class | Notes |
|---|---|---|---|---|
| 1793 | `private _markowitzProducts(step)` | s:865 | match | |
| 1794 | `const n = this._n;` | s:870 (`Size = Matrix->Size`) | match | |
| 1795 | `this._singletons = 0;` | s:874 | match | |
| 1796 | `for (let i = step; i < n; i++) {` | s:880 | match | |
| 1797 | `const r = this._markowitzRow[i];` | s:877 (`pMarkowitzRow = &MarkowitzRow[Step]`) | diff | C walks via pointer increment; digiTS reads by index. |
| 1798 | `const c = this._markowitzCol[i];` | s:878 | diff | Same drift. |
| 1799 | `if ((r > LARGEST_SHORT_INTEGER && c !== 0) ||` | s:882 | match | |
| 1800 | `(c > LARGEST_SHORT_INTEGER && r !== 0)) {` | s:883 | match | |
| 1801 | `const fp = r * c;` | s:884 (`fProduct = (double)... * (double)...`) | diff | C casts to `double` explicitly; JS multiply is always double — but the C version walks `pMarkowitzRow++` etc., changing iteration semantics. |
| 1802 | `this._markowitzProd[i] =` | s:886/s:888 | match | |
| 1803 | `fp >= LARGEST_LONG_INTEGER ? LARGEST_LONG_INTEGER : fp \| 0;` | s:885-888 | diff | Adds explicit `\| 0` truncation; ngspice casts via `(long)fProduct`. The truncation semantics differ for fProduct >= 2^31 negative range (impossible here but a structural drift). |
| 1804 | `} else {` | s:889 | match | |
| 1805 | `const product = r * c;` | s:890 | match | |
| 1806 | `this._markowitzProd[i] = product;` | s:891 | match | |
| 1807 | `if (product === 0) this._singletons++;` | s:891-892 | diff | C fuses assignment-and-test inside one expression `(*pMarkowitzProduct++ = Product) == 0`. digiTS splits assignment from increment from test. |
| 1808-1810 | braces | s:893-895 | — | |

### Lines 1820-1832 — `_searchForPivot`

| TS line | TS source | C file:line | Class | Notes |
|---|---|---|---|---|
| 1820 | `private _searchForPivot(step)` | s:947 | diff | Drops `DiagPivoting` arg. |
| 1821 | `let chosen: number;` | s:950 | match | |
| 1822 | `if (this._singletons > 0) {` | s:955 | match | |
| 1823 | `chosen = this._searchForSingleton(step);` | s:956 | match | |
| 1824 | `if (chosen >= 0) return chosen;` | s:957-960 | diff | Misses `Matrix->PivotSelectionMethod = 's'` (s:958). |
| 1825 | `}` | s:961 | — | |
| 1827 | `chosen = this._quicklySearchDiagonal(step);` | s:971 | match | |
| 1828 | `if (chosen >= 0) return chosen;` | s:972-975 | diff | Misses `PivotSelectionMethod = 'q'` (s:973). |
| 1829 | `chosen = this._searchDiagonal(step);` | s:981 | match | |
| 1830 | `if (chosen >= 0) return chosen;` | s:982-985 | diff | Misses `PivotSelectionMethod = 'd'` (s:983). |
| 1831 | `return this._searchEntireMatrix(step);` | s:990-993 | diff | Misses `PivotSelectionMethod = 'e'` (s:991). |
| 1832 | `}` | s:994 | — | |

### Lines 1848-1943 — `_searchForSingleton`

| TS line | TS source | C file:line | Class | Notes |
|---|---|---|---|---|
| 1848 | `private _searchForSingleton(step)` | s:1041 | match | |
| 1849 | `const n = this._n;` | (alias) | match | |
| 1850 | `const mProd = this._markowitzProd;` | (alias) | match | |
| 1855 | `let p = n;` | s:1051 (`pMarkowitzProduct = &MarkowitzProd[Size+1]`) | diff | C uses pointer-into-array; digiTS uses index. |
| 1856 | `mProd[n] = mProd[step];` | s:1052 | match | |
| 1860 | `let singletons = this._singletons;` | s:1056 (`Singletons = Matrix->Singletons--;`) | diff | C fuses read-with-decrement; digiTS splits. |
| 1861 | `this._singletons--;` | s:1056 | diff | Split half. |
| 1866 | `if (step >= 1) mProd[step - 1] = 0;` | s:1063 (`MarkowitzProd[Step-1] = 0`) | diff | Adds `step >= 1` guard with no C analogue. |
| 1868 | `while (singletons-- > 0) {` | s:1065 | match | |
| 1872 | `do {` | s:1087 (`while (*pMarkowitzProduct--) {}`) | diff | Replaces post-decrement-while with do/while. |
| 1873 | `v = (p >= 0) ? mProd[p] : 0;` | s:1087 | diff | Adds bounds guard; C dereferences unconditionally. |
| 1874 | `p--;` | s:1087 | diff | Pulled out of fused expression. |
| 1875 | `} while (v !== 0);` | s:1087 | diff | While-test reorganised. |
| 1877 | `let i = p + 1;` | s:1095 (`I = pMarkowitzProduct - MarkowitzProd + 1`) | match | Same arithmetic adapted to index. |
| 1880 | `if (i < step) break;` | s:1098 | match | |
| 1881 | `if (i > n - 1) i = step;` | s:1099 (`if (I > Size) I = Step`) | match | |
| 1884 | `const diagE = this._diag[i];` | s:1102 (`(ChosenPivot = Matrix->Diag[I]) != NULL`) | diff | C fuses assignment-and-test; digiTS reads then tests. |
| 1885 | `if (diagE >= 0) {` | s:1102 | diff | Split half. |
| 1887 | `const pivotMag = Math.abs(this._elVal[diagE]);` | s:1104 | match | |
| 1888 | `if (pivotMag > this._absThreshold &&` | s:1106 | match | |
| 1889 | `pivotMag > this._relThreshold * this._findBiggestInColExclude(diagE, step)) {` | s:1107-1108 | match | |
| 1890 | `return diagE;` | s:1109 | match | |
| 1891 | `}` | (brace) | — | |
| 1892 | `} else {` | s:1110 | match | |
| 1894 | `if (this._markowitzCol[i] === 0) {` | s:1112 | match | |
| 1895 | `let chosen = this._colHead[i];` | s:1113 | match | |
| 1896 | `while (chosen >= 0 && this._elRow[chosen] < step) chosen = this._elNextInCol[chosen];` | s:1114-1115 | match | |
| 1897 | `if (chosen >= 0) {` | s:1116 (`if (ChosenPivot != NULL)`) | match | |
| 1902 | `break;` | s:1118 | match | (preserves the inverted-condition bug). |
| 1903 | `}` | (brace) | — | |
| 1904 | `const pivotMag = chosen >= 0 ? Math.abs(this._elVal[chosen]) : 0;` | s:1120 (`PivotMag = ELEMENT_MAG(ChosenPivot)`) | diff | Adds null-guard; C unconditionally dereferences (UB on chosen==NULL). |
| 1905 | `if (pivotMag > this._absThreshold &&` | s:1122 | match | |
| 1906 | `pivotMag > this._relThreshold * this._findBiggestInColExclude(chosen, step)) {` | s:1123-1125 | match | |
| 1907 | `return chosen;` | s:1126 | match | |
| 1908 | `} else {` | s:1127 | match | |
| 1909 | `if (this._markowitzRow[i] === 0) {` | s:1128 | match | |
| 1910 | `let chosen2 = this._rowHead[i];` | s:1129 | match | |
| 1911 | `while (chosen2 >= 0 && this._elCol[chosen2] < step) chosen2 = this._elNextInRow[chosen2];` | s:1130-1131 | match | |
| 1912 | `if (chosen2 >= 0) {` | s:1132 | match | |
| 1914 | `break;` | s:1134 | match | |
| 1915 | `}` | (brace) | — | |
| 1916 | `const pivotMag2 = chosen2 >= 0 ? Math.abs(this._elVal[chosen2]) : 0;` | s:1136 | diff | Same null-guard injection. |
| 1917 | `if (pivotMag2 > this._absThreshold &&` | s:1138 | match | |
| 1918 | `pivotMag2 > this._relThreshold * this._findBiggestInColExclude(chosen2, step)) {` | s:1139-1142 | match | |
| 1919 | `return chosen2;` | s:1143 | match | |
| 1920-1922 | braces | s:1144-1145 | — | |
| 1923 | `} else {` | s:1146 | match | |
| 1924 | `let chosen = this._rowHead[i];` | s:1147 | match | |
| 1925 | `while (chosen >= 0 && this._elCol[chosen] < step) chosen = this._elNextInRow[chosen];` | s:1148-1149 | match | |
| 1926 | `if (chosen >= 0) {` | s:1150 | match | |
| 1928 | `break;` | s:1152 | match | |
| 1929 | `}` | (brace) | — | |
| 1930 | `const pivotMag = chosen >= 0 ? Math.abs(this._elVal[chosen]) : 0;` | s:1154 | diff | Null-guard injection. |
| 1931 | `if (pivotMag > this._absThreshold &&` | s:1156 | match | |
| 1932 | `pivotMag > this._relThreshold * this._findBiggestInColExclude(chosen, step)) {` | s:1157-1159 | match | |
| 1933 | `return chosen;` | s:1160 | match | |
| 1934-1936 | braces | s:1161-1162 | — | |
| 1938 | `}` | s:1164 | — | end while. |
| 1941 | `this._singletons++;` | s:1170 | match | |
| 1942 | `return -1;` | s:1171 | match | |
| 1943 | `}` | s:1172 | — | |

### Lines 1952-2052 — `_quicklySearchDiagonal`

| TS line | TS source | C file:line | Class | Notes |
|---|---|---|---|---|
| 1952 | `private _quicklySearchDiagonal(step)` | s:1255 | match | |
| 1953 | `const n = this._n;` | (alias) | match | |
| 1954 | `const mProd = this._markowitzProd;` | (alias) | match | |
| 1955 | `let numberOfTies = -1;` | s:1266 | match | |
| 1956 | `let minMarkowitzProduct = LARGEST_LONG_INTEGER;` | s:1267 | match | |
| 1958 | `let p = n + 1;` | s:1268 (`pMarkowitzProduct = &MarkowitzProd[Size+2]`) | match | Adapted to 0-based index. |
| 1959 | `mProd[n] = mProd[step];` | s:1269 | match | |
| 1962 | `if (step >= 1) mProd[step - 1] = -1;` | s:1272 | diff | Adds `step >= 1` guard. |
| 1964 | `const tied: number[] = new Array(MAX_MARKOWITZ_TIES + 1);` | s:1260 (stack array) | diff | Heap-allocated each call. |
| 1967 | `for (;;) {` | s:1293 | match | |
| 1972 | `do { p--; v = (p>=0)? mProd[p] : -1; } while (minMarkowitzProduct < v);` | s:1294 | diff | Replaces pre-decrement while with do/while + bounds guard. |
| 1973 | `p--;` | s:1294 | diff | (part of fused loop) |
| 1974 | `v = (p >= 0) ? mProd[p] : -1;` | s:1294 | diff | Bounds guard added. |
| 1975 | `} while (minMarkowitzProduct < v);` | s:1294 | diff | |
| 1977 | `let i = p;` | s:1303 | match | |
| 1980 | `if (i < step) break;` | s:1306 | match | |
| 1981 | `if (i > n - 1) i = step;` | s:1307 | match | |
| 1983 | `const pDiag = this._diag[i];` | s:1309 | diff | Split read from C's fused `(pDiag = Diag[I]) == NULL`. |
| 1984 | `if (pDiag < 0) continue;` | s:1309-1310 | diff | Split half. |
| 1985 | `const magnitude = Math.abs(this._elVal[pDiag]);` | s:1311 | diff | Split read from C's fused `(Magnitude = ELEMENT_MAG(pDiag)) <= AbsThreshold`. |
| 1986 | `if (magnitude <= this._absThreshold) continue;` | s:1311-1312 | diff | Split half. |
| 1988 | `if (mProd[p] === 1) {` | s:1314 | match | |
| 1990 | `let pOtherInRow = this._elNextInRow[pDiag];` | s:1318 | match | |
| 1991 | `let pOtherInCol = this._elNextInCol[pDiag];` | s:1319 | match | |
| 1992 | `if (pOtherInRow < 0 && pOtherInCol < 0) {` | s:1320 | match | |
| 1993 | `pOtherInRow = this._rowHead[i];` | s:1321 | match | |
| 1994 | `while (pOtherInRow >= 0) {` | s:1322 | match | |
| 1995 | `const c = this._elCol[pOtherInRow];` | s:1323 (read for test) | match | |
| 1996 | `if (c >= step && c !== i) break;` | s:1323-1324 | match | |
| 1997 | `pOtherInRow = this._elNextInRow[pOtherInRow];` | s:1325 | match | |
| 1998 | `}` | s:1326 | — | |
| 1999 | `pOtherInCol = this._colHead[i];` | s:1327 | match | |
| 2000 | `while (pOtherInCol >= 0) {` | s:1328 | match | |
| 2001 | `const r = this._elRow[pOtherInCol];` | s:1329 | match | |
| 2002 | `if (r >= step && r !== i) break;` | s:1329-1330 | match | |
| 2003 | `pOtherInCol = this._elNextInCol[pOtherInCol];` | s:1331 | match | |
| 2004 | `}` | s:1332 | — | |
| 2005 | `}` | s:1333 | — | |
| 2009 | `if (pOtherInRow >= 0 && pOtherInCol >= 0) {` | s:1337 | match | |
| 2010 | `if (this._elCol[pOtherInRow] === this._elRow[pOtherInCol]) {` | s:1338 | match | |
| 2011 | `const largestOffDiagonal = Math.max(...);` | s:1339-1340 | match | |
| 2012 | `Math.abs(this._elVal[pOtherInRow]),` | s:1339 | match | |
| 2013 | `Math.abs(this._elVal[pOtherInCol]),` | s:1340 | match | |
| 2014 | `);` | (closing) | — | |
| 2015 | `if (magnitude >= largestOffDiagonal) {` | s:1341 | match | |
| 2016 | `return pDiag;` | s:1343 | match | |
| 2017-2020 | braces | s:1344-1347 | — | |
| 2022 | `if (mProd[p] < minMarkowitzProduct) {` | s:1349 | match | |
| 2024 | `tied[0] = pDiag;` | s:1351 | match | |
| 2025 | `minMarkowitzProduct = mProd[p];` | s:1352 | match | |
| 2026 | `numberOfTies = 0;` | s:1353 | match | |
| 2027 | `} else {` | s:1354 | match | |
| 2029 | `if (numberOfTies < MAX_MARKOWITZ_TIES) {` | s:1356 | match | |
| 2030 | `tied[++numberOfTies] = pDiag;` | s:1357 | match | |
| 2031 | `if (numberOfTies >= minMarkowitzProduct * TIES_MULTIPLIER) break;` | s:1358-1359 | match | |
| 2032-2034 | braces | s:1360-1362 | — | |
| 2036 | `if (numberOfTies < 0) return -1;` | s:1365-1366 | match | |
| 2039 | `let chosen = -1;` | s:1369 | match | |
| 2040 | `let maxRatio = 1.0 / this._relThreshold;` | s:1370 | match | |
| 2041 | `for (let j = 0; j <= numberOfTies; j++) {` | s:1372 | match | |
| 2042 | `const pDiag = tied[j];` | s:1373 | match | |
| 2043 | `const magnitude = Math.abs(this._elVal[pDiag]);` | s:1374 | match | |
| 2044 | `const largestInCol = this._findBiggestInColExclude(pDiag, step);` | s:1375 | match | |
| 2045 | `const ratio = largestInCol / magnitude;` | s:1376 | match | |
| 2046 | `if (ratio < maxRatio) {` | s:1377 | match | |
| 2047 | `chosen = pDiag;` | s:1378 | match | |
| 2048 | `maxRatio = ratio;` | s:1379 | match | |
| 2049-2050 | braces | s:1380-1381 | — | |
| 2051 | `return chosen;` | s:1382 | match | |
| 2052 | `}` | s:1383 | — | |

### Lines 2057-2102 — `_searchDiagonal`

| TS line | TS source | C file:line | Class | Notes |
|---|---|---|---|---|
| 2057 | `private _searchDiagonal(step)` | s:1604 | match | |
| 2058 | `const n = this._n;` | s:1612 (`Size = Matrix->Size`) | match | |
| 2059 | `const size = n - 1;` | (no analogue; digiTS-only convenience) | diff | C uses `Size` directly. |
| 2060 | `const mProd = this._markowitzProd;` | (alias) | match | |
| 2061 | `let chosen = -1;` | s:1620 | match | |
| 2062 | `let minMarkowitzProduct = LARGEST_LONG_INTEGER;` | s:1621 | match | |
| 2063 | `let ratioOfAccepted = 0;` | s:1616 | match | |
| 2064 | `let numberOfTies = 0;` | s:1611 | match | |
| 2066 | `let p = n + 1;` | s:1622 (`pMarkowitzProduct = &MarkowitzProd[Size+2]`) | match | |
| 2067 | `mProd[n] = mProd[step];` | s:1623 | match | |
| 2070 | `for (let j = n; j > step; j--) {` | s:1626 (`for (J = Size+1; J > Step; J--)`) | match | |
| 2071 | `p--;` | s:1627 (`*(--pMarkowitzProduct)`) | diff | Pulled out of conditional. |
| 2072 | `if (p < 0) break;` | (no counterpart) | diff | digiTS-only bounds guard; C relies on Step-1 sentinel. |
| 2073 | `if (mProd[p] > minMarkowitzProduct) continue;` | s:1627-1628 | diff | C fuses `*(--pMarkowitzProduct) > MinMarkowitzProduct`. |
| 2074 | `let i: number;` | s:1609 (decl) | match | |
| 2075 | `if (j > size) i = step; else i = j;` | s:1629-1632 | diff | Replaces `if (J > Matrix->Size) I = Step; else I = J;` with one-line ternary-style. |
| 2076 | `const pDiag = this._diag[i];` | s:1633 | diff | Split from C's fused assignment-and-test. |
| 2077 | `if (pDiag < 0) continue;` | s:1633-1634 | diff | Split half. |
| 2078 | `const magnitude = Math.abs(this._elVal[pDiag]);` | s:1635 | diff | Split from fused. |
| 2079 | `if (magnitude <= this._absThreshold) continue;` | s:1635-1636 | diff | Split half. |
| 2082 | `const largestInCol = this._findBiggestInColExclude(pDiag, step);` | s:1639 | match | |
| 2083 | `if (magnitude <= this._relThreshold * largestInCol) continue;` | s:1640-1641 | match | |
| 2085 | `if (mProd[p] < minMarkowitzProduct) {` | s:1643 | match | |
| 2086 | `chosen = pDiag;` | s:1646 | match | |
| 2087 | `minMarkowitzProduct = mProd[p];` | s:1647 | match | |
| 2088 | `ratioOfAccepted = largestInCol / magnitude;` | s:1648 | match | |
| 2089 | `numberOfTies = 0;` | s:1649 | match | |
| 2090 | `} else {` | s:1650 | match | |
| 2092 | `numberOfTies++;` | s:1652 | match | |
| 2093 | `const ratio = largestInCol / magnitude;` | s:1653 | match | |
| 2094 | `if (ratio < ratioOfAccepted) {` | s:1654 | match | |
| 2095 | `chosen = pDiag;` | s:1655 | match | |
| 2096 | `ratioOfAccepted = ratio;` | s:1656 | match | |
| 2097 | `}` | s:1657 | — | |
| 2098 | `if (numberOfTies >= minMarkowitzProduct * TIES_MULTIPLIER) return chosen;` | s:1658-1659 | match | |
| 2099-2100 | braces | s:1660-1661 | — | |
| 2101 | `return chosen;` | s:1662 | match | |
| 2102 | `}` | s:1663 | — | |

### Lines 2110-2166 — `_searchEntireMatrix`

| TS line | TS source | C file:line | Class | Notes |
|---|---|---|---|---|
| 2110 | `private _searchEntireMatrix(step)` | s:1730 | match | |
| 2111 | `const n = this._n;` | s:1733 | match | |
| 2112 | `let chosen = -1;` | s:1744 | match | |
| 2113 | `let pLargestElement = -1;` | s:1738 | match | |
| 2114 | `let largestElementMag = 0;` | s:1745 | match | |
| 2115 | `let minMarkowitzProduct = LARGEST_LONG_INTEGER;` | s:1746 | match | |
| 2116 | `let ratioOfAccepted = 0;` | s:1740 | match | |
| 2117 | `let numberOfTies = 0;` | s:1735 | match | |
| 2118 | `const mRow = this._markowitzRow;` | (alias) | match | |
| 2119 | `const mCol = this._markowitzCol;` | (alias) | match | |
| 2121 | `for (let i = step; i < n; i++) {` | s:1749 | match | |
| 2122 | `let pElement = this._colHead[i];` | s:1750 | match | |
| 2123 | `while (pElement >= 0 && this._elRow[pElement] < step) pElement = this._elNextInCol[pElement];` | s:1752-1753 | match | |
| 2125 | `const largestInCol = this._findLargestInCol(pElement);` | s:1755 | match | |
| 2126 | `if (largestInCol === 0) continue;` | s:1755-1756 | diff | C fuses `(LargestInCol = FindLargestInCol(...)) == 0.0`. |
| 2128 | `while (pElement >= 0) {` | s:1758 | match | |
| 2129 | `const magnitude = Math.abs(this._elVal[pElement]);` | s:1761 | diff | Split from C's fused `(Magnitude = ELEMENT_MAG) > LargestElementMag`. |
| 2130 | `if (magnitude > largestElementMag) {` | s:1761 | diff | Split half. |
| 2131 | `largestElementMag = magnitude;` | s:1762 | match | |
| 2132 | `pLargestElement = pElement;` | s:1763 | match | |
| 2133 | `}` | (brace) | — | |
| 2134 | `const product = mRow[this._elRow[pElement]] * mCol[this._elCol[pElement]];` | s:1766-1767 | match | |
| 2135 | `if (product <= minMarkowitzProduct &&` | s:1771 | match | |
| 2136 | `magnitude > this._relThreshold * largestInCol &&` | s:1772 | match | |
| 2137 | `magnitude > this._absThreshold) {` | s:1773 | match | |
| 2138 | `if (product < minMarkowitzProduct) {` | s:1777 | match | |
| 2139 | `chosen = pElement;` | s:1780 | match | |
| 2140 | `minMarkowitzProduct = product;` | s:1781 | match | |
| 2141 | `ratioOfAccepted = largestInCol / magnitude;` | s:1782 | match | |
| 2142 | `numberOfTies = 0;` | s:1783 | match | |
| 2143 | `} else {` | s:1784 | match | |
| 2144 | `numberOfTies++;` | s:1786 | match | |
| 2145 | `const ratio = largestInCol / magnitude;` | s:1787 | match | |
| 2146 | `if (ratio < ratioOfAccepted) {` | s:1788 | match | |
| 2147 | `chosen = pElement;` | s:1789 | match | |
| 2148 | `ratioOfAccepted = ratio;` | s:1790 | match | |
| 2149 | `}` | (brace) | — | |
| 2150 | `if (numberOfTies >= minMarkowitzProduct * TIES_MULTIPLIER) return chosen;` | s:1792-1793 | match | |
| 2151-2152 | braces | s:1794-1795 | — | |
| 2153 | `pElement = this._elNextInCol[pElement];` | s:1796 | match | |
| 2154-2155 | braces | s:1797-1798 | — | |
| 2157 | `if (chosen >= 0) return chosen;` | s:1800 | match | |
| 2163 | `if (largestElementMag === 0) return -1;` | s:1802-1804 | diff | Drops `Matrix->Error = spSINGULAR` (s:1803). |
| 2164 | `this._error = spSMALL_PIVOT;` | s:1807 | match | |
| 2165 | `return pLargestElement;` | s:1808 | match | |
| 2166 | `}` | s:1809 | — | |

### Lines 2191-2239 — `_spcRowExchange`

| TS line | TS source | C file:line | Class | Notes |
|---|---|---|---|---|
| 2191 | `private _spcRowExchange(row1Arg, row2Arg)` | s:2110 | match | |
| 2192 | `let row1 = row1Arg, row2 = row2Arg;` | (no analogue; digiTS-only because args immutable) | diff | C reuses parameter names directly. |
| 2193 | `if (row1 > row2) { const t = row1; row1 = row2; row2 = t; }` | s:2117 (`SWAP(int, Row1, Row2)`) | diff | Hand-expanded SWAP macro. |
| 2196 | `let p1 = this._rowHead[row1];` | s:2119 | match | |
| 2197 | `let p2 = this._rowHead[row2];` | s:2120 | match | |
| 2198 | `while (p1 >= 0 \|\| p2 >= 0) {` | s:2121 | match | |
| 2199-2201 | local decls | s:2113-2114 (decls hoisted) | diff | Decls inside loop in TS, outside in C. |
| 2202 | `if (p1 < 0) {` | s:2123 | match | |
| 2203 | `column = this._elCol[p2];` | s:2124 | match | |
| 2204 | `element1 = -1; element2 = p2;` | s:2125-2126 | diff | Two C lines fused into one statement. |
| 2205 | `p2 = this._elNextInRow[p2];` | s:2127 | match | |
| 2206 | `} else if (p2 < 0) {` | s:2128 | match | |
| 2207 | `column = this._elCol[p1];` | s:2129 | match | |
| 2208 | `element1 = p1; element2 = -1;` | s:2130-2131 | diff | Two C lines fused. |
| 2209 | `p1 = this._elNextInRow[p1];` | s:2132 | match | |
| 2210 | `} else if (this._elCol[p1] < this._elCol[p2]) {` | s:2133 | match | |
| 2211 | `column = this._elCol[p1];` | s:2134 | match | |
| 2212 | `element1 = p1; element2 = -1;` | s:2135-2136 | diff | Fused. |
| 2213 | `p1 = this._elNextInRow[p1];` | s:2137 | match | |
| 2214 | `} else if (this._elCol[p1] > this._elCol[p2]) {` | s:2138 | match | |
| 2215 | `column = this._elCol[p2];` | s:2139 | match | |
| 2216 | `element1 = -1; element2 = p2;` | s:2140-2141 | diff | Fused. |
| 2217 | `p2 = this._elNextInRow[p2];` | s:2142 | match | |
| 2218 | `} else {` | s:2143 | match | |
| 2219 | `column = this._elCol[p1];` | s:2144 | match | |
| 2220 | `element1 = p1; element2 = p2;` | s:2145-2146 | diff | Fused. |
| 2221 | `p1 = this._elNextInRow[p1];` | s:2147 | match | |
| 2222 | `p2 = this._elNextInRow[p2];` | s:2148 | match | |
| 2223 | `}` | s:2149 | — | |
| 2224 | `this._exchangeColElements(row1, element1, row2, element2, column);` | s:2151 | match | |
| 2225 | `}` | s:2152 | — | |
| 2228 | `const mr = this._markowitzRow[row1];` | s:2155 (`SWAP(int, MarkowitzRow[Row1], MarkowitzRow[Row2])`) | diff | C gates on `InternalVectorsAllocated` (s:2154); digiTS does not. Also expanded SWAP. |
| 2229 | `this._markowitzRow[row1] = this._markowitzRow[row2];` | s:2155 | diff | |
| 2230 | `this._markowitzRow[row2] = mr;` | s:2155 | diff | |
| 2231 | `const fr = this._rowHead[row1];` | s:2156 | diff | Expanded SWAP. |
| 2232 | `this._rowHead[row1] = this._rowHead[row2];` | s:2156 | diff | |
| 2233 | `this._rowHead[row2] = fr;` | s:2156 | diff | |
| 2234 | `const ir = this._intToExtRow[row1];` | s:2157 | diff | Expanded SWAP. |
| 2235 | `this._intToExtRow[row1] = this._intToExtRow[row2];` | s:2157 | diff | |
| 2236 | `this._intToExtRow[row2] = ir;` | s:2157 | diff | |
| 2237 | `this._extToIntRow[this._intToExtRow[row1]] = row1;` | s:2159 | match | |
| 2238 | `this._extToIntRow[this._intToExtRow[row2]] = row2;` | s:2160 | match | |
| 2239 | `}` | s:2163 | — | |

### Lines 2244-2292 — `_spcColExchange`

| TS line | TS source | C file:line | Class | Notes |
|---|---|---|---|---|
| 2244 | `private _spcColExchange(col1Arg, col2Arg)` | s:2204 | match | |
| 2245 | `let col1 = col1Arg, col2 = col2Arg;` | (digiTS-only) | diff | |
| 2246 | `if (col1 > col2) { const t = col1; col1 = col2; col2 = t; }` | s:2211 | diff | Expanded SWAP. |
| 2249 | `let p1 = this._colHead[col1];` | s:2213 | match | |
| 2250 | `let p2 = this._colHead[col2];` | s:2214 | match | |
| 2251 | `while (p1 >= 0 \|\| p2 >= 0) {` | s:2215 | match | |
| 2252-2254 | local decls | s:2207-2208 | diff | Decls in loop in TS. |
| 2255 | `if (p1 < 0) {` | s:2217 | match | |
| 2256 | `row = this._elRow[p2];` | s:2218 | match | |
| 2257 | `element1 = -1; element2 = p2;` | s:2219-2220 | diff | Fused. |
| 2258 | `p2 = this._elNextInCol[p2];` | s:2221 | match | |
| 2259 | `} else if (p2 < 0) {` | s:2222 | match | |
| 2260 | `row = this._elRow[p1];` | s:2223 | match | |
| 2261 | `element1 = p1; element2 = -1;` | s:2224-2225 | diff | Fused. |
| 2262 | `p1 = this._elNextInCol[p1];` | s:2226 | match | |
| 2263 | `} else if (this._elRow[p1] < this._elRow[p2]) {` | s:2227 | match | |
| 2264 | `row = this._elRow[p1];` | s:2228 | match | |
| 2265 | `element1 = p1; element2 = -1;` | s:2229-2230 | diff | Fused. |
| 2266 | `p1 = this._elNextInCol[p1];` | s:2231 | match | |
| 2267 | `} else if (this._elRow[p1] > this._elRow[p2]) {` | s:2232 | match | |
| 2268 | `row = this._elRow[p2];` | s:2233 | match | |
| 2269 | `element1 = -1; element2 = p2;` | s:2234-2235 | diff | Fused. |
| 2270 | `p2 = this._elNextInCol[p2];` | s:2236 | match | |
| 2271 | `} else {` | s:2237 | match | |
| 2272 | `row = this._elRow[p1];` | s:2238 | match | |
| 2273 | `element1 = p1; element2 = p2;` | s:2239-2240 | diff | Fused. |
| 2274 | `p1 = this._elNextInCol[p1];` | s:2241 | match | |
| 2275 | `p2 = this._elNextInCol[p2];` | s:2242 | match | |
| 2276 | `}` | s:2243 | — | |
| 2277 | `this._exchangeRowElements(col1, element1, col2, element2, row);` | s:2245 | match | |
| 2278 | `}` | s:2246 | — | |
| 2281 | `const mc = this._markowitzCol[col1];` | s:2249 | diff | No `InternalVectorsAllocated` gate; expanded SWAP. |
| 2282 | `this._markowitzCol[col1] = this._markowitzCol[col2];` | s:2249 | diff | |
| 2283 | `this._markowitzCol[col2] = mc;` | s:2249 | diff | |
| 2284 | `const fc = this._colHead[col1];` | s:2250 | diff | Expanded SWAP. |
| 2285 | `this._colHead[col1] = this._colHead[col2];` | s:2250 | diff | |
| 2286 | `this._colHead[col2] = fc;` | s:2250 | diff | |
| 2287 | `const ic = this._preorderColPerm[col1];` | s:2251 (`IntToExtColMap`) | diff | digiTS uses `_preorderColPerm` (different array). |
| 2288 | `this._preorderColPerm[col1] = this._preorderColPerm[col2];` | s:2251 | diff | |
| 2289 | `this._preorderColPerm[col2] = ic;` | s:2251 | diff | |
| 2290 | `this._extToIntCol[this._preorderColPerm[col1]] = col1;` | s:2253 | diff | Reads `_preorderColPerm` not `IntToExtColMap`. |
| 2291 | `this._extToIntCol[this._preorderColPerm[col2]] = col2;` | s:2254 | diff | |
| 2292 | `}` | s:2257 | — | |

### Lines 2299-2311 — `_setColLink` / `_setRowLink`

| TS line | TS source | C file:line | Class | Notes |
|---|---|---|---|---|
| 2299 | `private _setColLink(prev, e, col)` | (no fn; pattern `*ElementAboveRow = X`) | diff (digiTS-only) | Helper wrapper. |
| 2300 | `if (prev < 0) this._colHead[col] = e;` | s:2311 (`*ElementAboveRow1 = &(FirstInCol[Column])`) | diff | Inverts the C pattern (C carries the address-of-pointer; digiTS branches on `prev < 0`). |
| 2301 | `else this._elNextInCol[prev] = e;` | s:2314 (`*ElementAboveRow1 = &(pElement->NextInCol)`) | diff | Other half. |
| 2302 | `}` | — | — | |
| 2308 | `private _setRowLink(prev, e, row)` | (no fn) | diff (digiTS-only) | |
| 2309 | `if (prev < 0) this._rowHead[row] = e;` | s:2440 | diff | Same wrapper drift. |
| 2310 | `else this._elNextInRow[prev] = e;` | s:2443 | diff | |
| 2311 | `}` | — | — | |

### Lines 2321-2409 — `_exchangeColElements`

| TS line | TS source | C file:line | Class | Notes |
|---|---|---|---|---|
| 2321 | `private _exchangeColElements(row1, e1, row2, e2, column)` | s:2302 | match | |
| 2324-2328 | local decls | s:2305-2307 | match | Same set, different syntax. |
| 2331 | `elementAboveRow1 = -1;` | s:2311 (`= &(FirstInCol[Column])`) | diff | Different sentinel pattern. |
| 2332 | `pElement = this._colHead[column];` | s:2312 (`pElement = *ElementAboveRow1`) | diff | Implements the deref via head read. |
| 2333 | `while (pElement >= 0 && this._elRow[pElement] < row1) {` | s:2313 | diff | Adds `pElement >= 0` guard; C unconditionally derefs. |
| 2334 | `elementAboveRow1 = pElement;` | s:2314 (via address-of advance) | diff | Different idiom. |
| 2335 | `pElement = this._elNextInCol[pElement];` | s:2315 | diff | Same idiom. |
| 2336 | `}` | s:2316 | — | |
| 2337 | `if (e1 >= 0) {` | s:2317 | match | |
| 2338 | `elementBelowRow1 = this._elNextInCol[e1];` | s:2318 | match | |
| 2339 | `if (e2 < 0) {` | s:2319 | match | |
| 2341 | `if (elementBelowRow1 >= 0 && this._elRow[elementBelowRow1] < row2) {` | s:2321 | match | |
| 2343 | `this._setColLink(elementAboveRow1, elementBelowRow1, column);` | s:2323 | match | |
| 2346 | `pElement = elementBelowRow1;` | s:2326 | match | |
| 2347 | `elementAboveRow2 = -1;` | (digiTS-only init) | diff | C does not init; relies on do-while's first iteration setting via address-of. |
| 2348 | `do {` | s:2327 | match | |
| 2349 | `elementAboveRow2 = pElement;` | s:2328 | diff | C: `ElementAboveRow2 = &(pElement->NextInCol)`; digiTS captures the element itself. |
| 2350 | `pElement = this._elNextInCol[pElement];` | s:2329 | match | |
| 2351 | `} while (pElement >= 0 && this._elRow[pElement] < row2);` | s:2330 | match | |
| 2354 | `this._setColLink(elementAboveRow2, e1, column);` | s:2333 | match | |
| 2355 | `this._elNextInCol[e1] = pElement;` | s:2334 | match | |
| 2357 | `this._setColLink(elementAboveRow1, elementBelowRow1, column);` | s:2335 | match | (preserves the redundant write in ngspice). |
| 2358 | `}` | s:2336 | — | |
| 2359 | `this._elRow[e1] = row2;` | s:2337 | match | |
| 2360 | `} else {` | s:2338 | match | |
| 2362 | `if (this._elRow[elementBelowRow1] === row2) {` | s:2340 | match | |
| 2364 | `const e2Next = this._elNextInCol[e2];` | s:2342 (read) | match | |
| 2365 | `this._elNextInCol[e1] = e2Next;` | s:2342 | match | |
| 2366 | `this._elNextInCol[e2] = e1;` | s:2343 | match | |
| 2367 | `this._setColLink(elementAboveRow1, e2, column);` | s:2344 | match | |
| 2368 | `} else {` | s:2345 | match | |
| 2370 | `pElement = elementBelowRow1;` | s:2347 | match | |
| 2371 | `elementAboveRow2 = -1;` | (no analogue) | diff | digiTS-only init. |
| 2372 | `do {` | s:2348 | match | |
| 2373 | `elementAboveRow2 = pElement;` | s:2349 | diff | Same address-of vs element drift. |
| 2374 | `pElement = this._elNextInCol[pElement];` | s:2350 | match | |
| 2375 | `} while (pElement >= 0 && this._elRow[pElement] < row2);` | s:2351 | match | |
| 2377 | `elementBelowRow2 = this._elNextInCol[e2];` | s:2353 | match | |
| 2380 | `this._setColLink(elementAboveRow1, e2, column);` | s:2356 | match | |
| 2381 | `this._elNextInCol[e2] = elementBelowRow1;` | s:2357 | match | |
| 2382 | `this._setColLink(elementAboveRow2, e1, column);` | s:2358 | match | |
| 2383 | `this._elNextInCol[e1] = elementBelowRow2;` | s:2359 | match | |
| 2384 | `}` | s:2360 | — | |
| 2385 | `this._elRow[e1] = row2;` | s:2361 | match | |
| 2386 | `this._elRow[e2] = row1;` | s:2362 | match | |
| 2387 | `}` | s:2363 | — | |
| 2388 | `} else {` | s:2364 | match | |
| 2390 | `elementBelowRow1 = pElement;` | s:2366 | match | |
| 2391 | `elementAboveRow2 = -1;` | (no analogue) | diff | digiTS-only init. |
| 2394 | `if (this._elRow[elementBelowRow1] !== row2) {` | s:2369 | match | |
| 2395 | `do {` | s:2370 | match | |
| 2396 | `elementAboveRow2 = pElement;` | s:2371 | diff | Address-of vs element drift. |
| 2397 | `pElement = this._elNextInCol[pElement];` | s:2372 | match | |
| 2398 | `} while (pElement >= 0 && this._elRow[pElement] < row2);` | s:2373 | match | |
| 2400 | `elementBelowRow2 = this._elNextInCol[e2];` | s:2375 | match | |
| 2403 | `this._setColLink(elementAboveRow2, elementBelowRow2, column);` | s:2378 | match | |
| 2404 | `this._setColLink(elementAboveRow1, e2, column);` | s:2379 | match | |
| 2405 | `this._elNextInCol[e2] = elementBelowRow1;` | s:2380 | match | |
| 2406 | `}` | s:2381 | — | |
| 2407 | `this._elRow[e2] = row1;` | s:2382 | match | |
| 2408-2409 | braces | s:2383-2385 | — | |

### Lines 2416-2504 — `_exchangeRowElements`

Symmetric mirror. Drift pattern identical to `_exchangeColElements`.

| TS line | TS source | C file:line | Class | Notes |
|---|---|---|---|---|
| 2416 | `private _exchangeRowElements(col1, e1, col2, e2, row)` | s:2431 | match | |
| 2419-2423 | local decls | s:2434-2436 | match | |
| 2426 | `elementLeftOfCol1 = -1;` | s:2440 | diff | Sentinel pattern. |
| 2427 | `pElement = this._rowHead[row];` | s:2441 | diff | |
| 2428 | `while (pElement >= 0 && this._elCol[pElement] < col1) {` | s:2442 | diff | Adds `pElement >= 0`. |
| 2429 | `elementLeftOfCol1 = pElement;` | s:2443 | diff | |
| 2430 | `pElement = this._elNextInRow[pElement];` | s:2444 | diff | |
| 2431 | `}` | s:2445 | — | |
| 2432 | `if (e1 >= 0) {` | s:2446 | match | |
| 2433 | `elementRightOfCol1 = this._elNextInRow[e1];` | s:2447 | match | |
| 2434 | `if (e2 < 0) {` | s:2448 | match | |
| 2436 | `if (elementRightOfCol1 >= 0 && this._elCol[elementRightOfCol1] < col2) {` | s:2450 | match | |
| 2438 | `this._setRowLink(elementLeftOfCol1, elementRightOfCol1, row);` | s:2452 | match | |
| 2441 | `pElement = elementRightOfCol1;` | s:2455 | match | |
| 2442 | `elementLeftOfCol2 = -1;` | (digiTS-only) | diff | Init not in C. |
| 2443 | `do {` | s:2456 | match | |
| 2444 | `elementLeftOfCol2 = pElement;` | s:2457 | diff | Address-of vs element drift. |
| 2445 | `pElement = this._elNextInRow[pElement];` | s:2458 | match | |
| 2446 | `} while (pElement >= 0 && this._elCol[pElement] < col2);` | s:2459 | match | |
| 2449 | `this._setRowLink(elementLeftOfCol2, e1, row);` | s:2462 | match | |
| 2450 | `this._elNextInRow[e1] = pElement;` | s:2463 | match | |
| 2452 | `this._setRowLink(elementLeftOfCol1, elementRightOfCol1, row);` | s:2464 | match | |
| 2453 | `}` | s:2465 | — | |
| 2454 | `this._elCol[e1] = col2;` | s:2466 | match | |
| 2455 | `} else {` | s:2467 | match | |
| 2457 | `if (this._elCol[elementRightOfCol1] === col2) {` | s:2469 | match | |
| 2459 | `const e2Right = this._elNextInRow[e2];` | s:2471 | match | |
| 2460 | `this._elNextInRow[e1] = e2Right;` | s:2471 | match | |
| 2461 | `this._elNextInRow[e2] = e1;` | s:2472 | match | |
| 2462 | `this._setRowLink(elementLeftOfCol1, e2, row);` | s:2473 | match | |
| 2463 | `} else {` | s:2474 | match | |
| 2465 | `pElement = elementRightOfCol1;` | s:2476 | match | |
| 2466 | `elementLeftOfCol2 = -1;` | (digiTS-only) | diff | |
| 2467 | `do {` | s:2477 | match | |
| 2468 | `elementLeftOfCol2 = pElement;` | s:2478 | diff | Address-of drift. |
| 2469 | `pElement = this._elNextInRow[pElement];` | s:2479 | match | |
| 2470 | `} while (pElement >= 0 && this._elCol[pElement] < col2);` | s:2480 | match | |
| 2472 | `elementRightOfCol2 = this._elNextInRow[e2];` | s:2482 | match | |
| 2475 | `this._setRowLink(elementLeftOfCol1, e2, row);` | s:2485 | match | |
| 2476 | `this._elNextInRow[e2] = elementRightOfCol1;` | s:2486 | match | |
| 2477 | `this._setRowLink(elementLeftOfCol2, e1, row);` | s:2487 | match | |
| 2478 | `this._elNextInRow[e1] = elementRightOfCol2;` | s:2488 | match | |
| 2479 | `}` | s:2489 | — | |
| 2480 | `this._elCol[e1] = col2;` | s:2490 | match | |
| 2481 | `this._elCol[e2] = col1;` | s:2491 | match | |
| 2482 | `}` | s:2492 | — | |
| 2483 | `} else {` | s:2493 | match | |
| 2485 | `elementRightOfCol1 = pElement;` | s:2495 | match | |
| 2486 | `elementLeftOfCol2 = -1;` | (digiTS-only) | diff | |
| 2489 | `if (this._elCol[elementRightOfCol1] !== col2) {` | s:2498 | match | |
| 2490 | `do {` | s:2499 | match | |
| 2491 | `elementLeftOfCol2 = pElement;` | s:2500 | diff | Address-of drift. |
| 2492 | `pElement = this._elNextInRow[pElement];` | s:2501 | match | |
| 2493 | `} while (pElement >= 0 && this._elCol[pElement] < col2);` | s:2502 | match | |
| 2495 | `elementRightOfCol2 = this._elNextInRow[e2];` | s:2504 | match | |
| 2498 | `this._setRowLink(elementLeftOfCol2, elementRightOfCol2, row);` | s:2507 | match | |
| 2499 | `this._setRowLink(elementLeftOfCol1, e2, row);` | s:2508 | match | |
| 2500 | `this._elNextInRow[e2] = elementRightOfCol1;` | s:2509 | match | |
| 2501 | `}` | s:2510 | — | |
| 2502 | `this._elCol[e2] = col1;` | s:2511 | match | |
| 2503-2504 | braces | s:2512-2514 | — | |

### Lines 2511-2571 — `_exchangeRowsAndCols`

| TS line | TS source | C file:line | Class | Notes |
|---|---|---|---|---|
| 2511 | `private _exchangeRowsAndCols(pivotE, step)` | s:1986 | match | |
| 2512 | `const row = this._elRow[pivotE];` | s:1993 | match | |
| 2513 | `const col = this._elCol[pivotE];` | s:1994 | match | |
| 2515 | `if (row === step && col === step) {` | s:1998 | match | |
| 2517 | `return;` | s:1998 | match | |
| 2518 | `}` | (brace) | — | digiTS missing `PivotsOriginalRow/Col` writes (s:1995-1996) before this check. |
| 2520 | `if (row === col) {` | s:2001 | match | |
| 2521 | `this._spcRowExchange(step, row);` | s:2002 | match | |
| 2522 | `this._spcColExchange(step, col);` | s:2003 | match | |
| 2526 | `const mp = this._markowitzProd[step];` | s:2004 (`SWAP(long, MarkowitzProd[Step], MarkowitzProd[Row])`) | diff | Expanded SWAP. |
| 2527 | `this._markowitzProd[step] = this._markowitzProd[row];` | s:2004 | diff | |
| 2528 | `this._markowitzProd[row] = mp;` | s:2004 | diff | |
| 2529 | `const dr = this._diag[row];` | s:2005 | diff | Expanded SWAP. |
| 2530 | `this._diag[row] = this._diag[step];` | s:2005 | diff | |
| 2531 | `this._diag[step] = dr;` | s:2005 | diff | |
| 2532 | `} else {` | s:2006 | match | |
| 2533 | `const oldStep = this._markowitzProd[step];` | s:2009 | match | |
| 2534 | `const oldRow = this._markowitzProd[row];` | s:2010 | match | |
| 2535 | `const oldCol = this._markowitzProd[col];` | s:2011 | match | |
| 2537 | `if (row !== step) {` | s:2014 | match | |
| 2538 | `this._spcRowExchange(step, row);` | s:2015 | match | |
| 2539 | `this._markowitzProd[row] = this._markowitzRow[row] * this._markowitzCol[row];` | s:2018-2019 | diff | Misses preceding `NumberOfInterchangesIsOdd = !...` (s:2016-2017). |
| 2540 | `if ((this._markowitzProd[row] === 0) !== (oldRow === 0)) {` | s:2022 | match | |
| 2541 | `if (oldRow === 0) this._singletons--;` | s:2023-2024 | match | |
| 2542 | `else this._singletons++;` | s:2025-2026 | match | |
| 2543 | `}` | s:2027 | — | |
| 2544 | `}` | s:2028 | — | |
| 2546 | `if (col !== step) {` | s:2031 | match | |
| 2547 | `this._spcColExchange(step, col);` | s:2032 | match | |
| 2548 | `this._markowitzProd[col] = this._markowitzCol[col] * this._markowitzRow[col];` | s:2035-2036 | diff | Misses `NumberOfInterchangesIsOdd` toggle (s:2033-2034). |
| 2549 | `if ((this._markowitzProd[col] === 0) !== (oldCol === 0)) {` | s:2039 | match | |
| 2550 | `if (oldCol === 0) this._singletons--;` | s:2040-2041 | match | |
| 2551 | `else this._singletons++;` | s:2042-2043 | match | |
| 2552 | `}` | s:2044 | — | |
| 2553 | `this._diag[col] = this._findDiagOnColumn(col);` | s:2046-2048 (`spcFindElementInCol(...,Col,Col,NO)`) | diff | Calls digiTS specialised helper instead of generic ngspice fn. |
| 2554 | `}` | s:2049 | — | |
| 2555 | `if (row !== step) {` | s:2050 | match | |
| 2556 | `this._diag[row] = this._findDiagOnColumn(row);` | s:2051-2053 | diff | Same helper substitution. |
| 2557 | `}` | s:2054 | — | |
| 2558 | `this._diag[step] = this._findDiagOnColumn(step);` | s:2055-2057 | diff | Same helper substitution. |
| 2560 | `this._markowitzProd[step] = this._markowitzCol[step] * this._markowitzRow[step];` | s:2060-2061 | match | |
| 2561 | `if ((this._markowitzProd[step] === 0) !== (oldStep === 0)) {` | s:2062 | match | |
| 2562 | `if (oldStep === 0) this._singletons--;` | s:2063-2064 | match | |
| 2563 | `else this._singletons++;` | s:2065-2066 | match | |
| 2564 | `}` | s:2067 | — | |
| 2565 | `}` | s:2068 | — | |
| 2571 | `}` | s:2070 | — | digiTS lacks `PivotsOriginalRow/Col` field updates entirely. |

### Lines 2579-2619 — `_updateMarkowitzNumbers`

| TS line | TS source | C file:line | Class | Notes |
|---|---|---|---|---|
| 2579 | `private _updateMarkowitzNumbers(pivotE)` | s:2712 | match | |
| 2580 | `const mRow = this._markowitzRow;` | s:2717 | match | |
| 2581 | `const mCol = this._markowitzCol;` | s:2718 | match | |
| 2582 | `const mProd = this._markowitzProd;` | (alias) | match | |
| 2586 | `for (let p = this._elNextInCol[pivotE]; p >= 0; p = this._elNextInCol[p]) {` | s:2724 | match | |
| 2587 | `const row = this._elRow[p];` | s:2725 | match | |
| 2588 | `mRow[row]--;` | s:2726 | match | |
| 2589 | `if ((mRow[row] > LARGEST_SHORT_INTEGER && mCol[row] !== 0) \|\|` | s:2729 | match | |
| 2590 | `(mCol[row] > LARGEST_SHORT_INTEGER && mRow[row] !== 0)) {` | s:2730 | match | |
| 2591 | `const product = mCol[row] * mRow[row];` | s:2731 | match | |
| 2592 | `mProd[row] = product >= LARGEST_LONG_INTEGER` | s:2732-2735 | diff | Replaces explicit if/else with ternary; adds `\| 0` truncation. |
| 2593 | `? LARGEST_LONG_INTEGER` | s:2733 | match | |
| 2594 | `: product \| 0;` | s:2735 (`(long)Product`) | diff | `\| 0` vs `(long)`; both 32-bit truncation but different ops. |
| 2595 | `} else {` | s:2736 | match | |
| 2596 | `mProd[row] = mRow[row] * mCol[row];` | s:2736 | match | |
| 2597 | `}` | (brace) | — | |
| 2598 | `if (mRow[row] === 0) this._singletons++;` | s:2737-2738 | match | |
| 2599 | `}` | s:2739 | — | |
| 2603 | `for (let p = this._elNextInRow[pivotE]; p >= 0; p = this._elNextInRow[p]) {` | s:2741-2743 | match | |
| 2604 | `const col = this._elCol[p];` | s:2744 | match | |
| 2605 | `mCol[col]--;` | s:2745 | match | |
| 2606 | `if ((mRow[col] > LARGEST_SHORT_INTEGER && mCol[col] !== 0) \|\|` | s:2748 | match | |
| 2607 | `(mCol[col] > LARGEST_SHORT_INTEGER && mRow[col] !== 0)) {` | s:2749 | match | |
| 2608 | `const product = mCol[col] * mRow[col];` | s:2750 | match | |
| 2609 | `mProd[col] = product >= LARGEST_LONG_INTEGER` | s:2751-2754 | diff | Ternary vs C if/else. |
| 2610 | `? LARGEST_LONG_INTEGER` | s:2752 | match | |
| 2611 | `: product \| 0;` | s:2754 | diff | `\| 0` vs `(long)`. |
| 2612 | `} else {` | s:2755 | match | |
| 2613 | `mProd[col] = mRow[col] * mCol[col];` | s:2755 | match | |
| 2614 | `}` | (brace) | — | |
| 2617 | `if (mCol[col] === 0 && mRow[col] !== 0) this._singletons++;` | s:2756-2757 | match | |
| 2618 | `}` | s:2758 | — | |
| 2619 | `}` | s:2760 | — | |

## 4. Closing structural-drift summary (worst by likely numerical impact)

1. `preorder()` (TS 830-867) vs `spMNA_Preorder` (sputils.c:177-230): digiTS implements a single-pass StartAt cursor without ngspice's two-phase (lone twins → multi-twin) structure or the `CountTwins` helper. Different column permutations selected.
2. `_swapColumns()` (TS 920-934) and all SWAPs (TS 2228-2236, 2281-2291, 2526-2531) drop `NumberOfInterchangesIsOdd` toggling (sputils.c:299, spfactor.c:2016, 2033). Determinant sign tracking is lost.
3. `_exchangeRowsAndCols()` (TS 2515-2518) drops `Matrix->PivotsOriginalRow/Col` writes (spfactor.c:1995-1996). Downstream consumers that read these fields lose state.
4. `_searchEntireMatrix()` (TS 2163) drops `Matrix->Error = spSINGULAR` on the all-zero exit (spfactor.c:1803). Caller cannot distinguish singular from small-pivot.
5. `_searchForPivot()` (TS 1820-1832) drops all four `Matrix->PivotSelectionMethod` writes (spfactor.c:958, 973, 983, 991). Diagnostic data lost.
6. `_searchForSingleton()` injects bounds-guarded reads (TS 1873, 1904, 1916, 1930) where C unconditionally dereferences. Returns 0 or NaN where C would crash; mask vs propagate behavioural drift.
7. `_quicklySearchDiagonal()` inner loop (TS 1972-1975) replaces `while (Min < *(--p))` with do/while + `(p>=0)?:` bounds guard. Iteration count and final `p` differ when sentinel at `Step-1` is approached.
8. `_findBiggestInColExclude()` (TS 1719) adds an `e >= 0` guard absent from spfactor.c:1930. C falls into UB; digiTS silently sets Largest=0, masking same-row-only columns.
9. `_findBiggestInColExclude()` (TS 1726-1728) splits the `while ((p = p->NextInCol) != NULL)` advance/test from spfactor.c:1936 into separate statements. Behaviour matches but structure does not.
10. `_findTwin()` (TS 902-909) replaces ngspice `CountTwins` with a single-element finder and discards its `(*ppTwin1 = pTwin1)->Col = Col` side-effect (sputils.c:264). This is the only place ngspice writes `Col` for a freshly-allocated element pre-`spcLinkRows`.
11. `_spcRowExchange()` (TS 2228-2230) and `_spcColExchange()` (TS 2281-2283) drop the `InternalVectorsAllocated` guard (spfactor.c:2154, 2248). Markowitz arrays are swapped unconditionally; if Markowitz allocation is ever deferred, digiTS would NPE where ngspice would skip.
12. `_markowitzProducts()` (TS 1801-1803) replaces ngspice's `(double)*pMarkRow++ * (double)*pMarkCol++` (spfactor.c:884) and `(long)fProduct` cast with `r*c` and `fp \| 0`. Equivalent for in-range values, but `\| 0` differs from `(long)` for fProduct outside [-2^31, 2^31).
13. `_updateMarkowitzNumbers()` (TS 2592-2594, 2609-2611) uses ternary + `\| 0` vs C's if/else + `(long)`. Same drift as #12.
14. `_searchDiagonal()` (TS 2071-2073) splits the C pointer pre-decrement (spfactor.c:1627) into `p--; if (p<0) break; if (mProd[p] > min) continue;`. Iteration count matches but C's UB safety is replaced with explicit guard.
15. `_searchDiagonal()` (TS 2059) introduces `const size = n - 1` shadow with no C analogue at spfactor.c:1612.
16. `_exchangeColElements()` (TS 2347, 2371, 2391) inits `elementAboveRow2 = -1` before the do-while; ngspice never inits it because the address-of-pointer pattern (spfactor.c:2328) cannot be uninitialised on first iteration.
17. `_exchangeColElements()` chain walks (TS 2333, 2351, 2375, 2398) add `pElement >= 0` guards to do-while conditions where C unconditionally derefs `pElement->Row` (spfactor.c:2330, 2351, 2373).
18. `_exchangeRowElements()` (TS 2428, 2446, 2470, 2493) — same `pElement >= 0` guard injection vs spfactor.c:2442, 2459, 2480, 2502.
19. `_searchForPivot()` (TS 1820) drops the `DiagPivoting` parameter entirely; ngspice's `#if DIAGONAL_PIVOTING` branch is hard-wired on.
20. `_linkRows()` (TS 884) preclears `_rowHead` before re-linking; ngspice does not (spbuild.c:907 assumes `FirstInRow` was zeroed at allocation). digiTS-only safety pass that hides allocator-state drift.
21. `_linkRows()` epilogue is missing `Matrix->RowsLinked = YES` (spbuild.c:930). digiTS uses `_didPreorder` instead.
22. `preorder()` (TS 832) stamps `_didPreorder = true` BEFORE the work (vs ngspice setting `Reordered = YES` (sputils.c:189) before the loop). Different ordering relative to early-return sentinel `RowsLinked` (sputils.c:187).
23. `preorder()` (TS 846) tests `_diag[col] >= 0 && _elVal[_diag[col]] !== 0` instead of `Diag[J] == NULL` (sputils.c:198). digiTS treats numerical-zero diagonal as missing; ngspice keys solely on structural absence.
24. `_findDiagOnColumn()` (TS 943-950) replaces `spcFindElementInCol(...,Col,Col,NO)` with a column-only walk specialised for `(slot, slot)`. The C function has fill-in semantics (the `NO` arg suppresses them) which the digiTS variant cannot express.
25. `_searchForSingleton()` (TS 1860-1861) splits ngspice's fused `Singletons = Matrix->Singletons--;` into two statements. Same arithmetic.
26. `_searchForSingleton()` (TS 1872-1875) replaces `while (*pMarkowitzProduct--) {}` with do/while + bounds-guarded read. Same effect for valid sentinels but iteration count differs at boundaries.
27. `_quicklySearchDiagonal()` (TS 1964) heap-allocates `tied[]` per call; ngspice (spfactor.c:1260) uses a stack-resident `TiedElements[MAX_MARKOWITZ_TIES + 1]`.
28. `_spcRowExchange()`/`_spcColExchange()` parameter copies (TS 2192, 2245) into mutable locals; C uses macro SWAP on parameters directly.
29. `_setColLink`/`_setRowLink` (TS 2299-2311) implement a "branch on prev<0" wrapper for what C expresses as `*ElementAboveRow = X`. The C idiom holds an address-of-pointer; the digiTS idiom branches on a sentinel. Functionally consistent but every singly-linked-list write in `_exchangeColElements`/`_exchangeRowElements` flows through this divergence.
30. `_spcColExchange()` swaps `_preorderColPerm` instead of `IntToExtColMap` (TS 2287-2291 vs spfactor.c:2251-2254). digiTS keeps a separate preorder-time permutation array; this means the `IntToExtColMap` invariant ngspice maintains across all column swaps is split across two structures in digiTS.
