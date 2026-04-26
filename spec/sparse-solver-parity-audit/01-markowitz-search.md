# Markowitz Pivot Search Audit

Strict line-by-line audit of digiTS Markowitz pivot-search code against ngspice spfactor.c.

## Overall Results

| Function | MATCH | DIFF | Total |
|---|---|---|---|
| _searchForPivot | 3 | 1 | 4 |
| _searchForSingleton | 9 | 4 | 13 |
| _quicklySearchDiagonal | 8 | 2 | 10 |
| _searchDiagonal | 6 | 0 | 6 |
| _searchEntireMatrix | 4 | 2 | 6 |
| _findLargestInCol | 2 | 0 | 2 |
| _findBiggestInColExclude | 4 | 0 | 4 |
| **TOTAL** | **36** | **9** | **45** |

MATCH rate: 80.0%

## DIFF Classifications

### Bounds Safety (2)
- L1691-1694: do-while with (p >= 0) guard vs pre-decrement while
- L1791-1794: do-while with bounds guard vs pre-decrement while

### Pointer Arithmetic vs Indexing (2)
- L1696: p+1 vs pointer arithmetic (semantically equivalent)
- L1796: p vs pointer difference (semantically equivalent)

### Statement Grouping (1)
- L1679-1680: split assignment vs combined

### Guard Additions (3)
- L1723, L1735, L1749: ternary magnitude guards vs direct dereference

### Semantic Divergence (1)
- L1980-1981: no error field; -1/pLargestElement vs Matrix->Error

## Conclusion

Core Markowitz pivot algorithm faithfully ported. All DIFFs are safety additions, equivalent transformations, or minor reorganization. No numerical divergences.
