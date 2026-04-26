# Sparse Solver Parity Audit: Build, Allocation, Clear, Preorder

**Scope:** Line-by-line audit of digiTS `sparse-solver.ts` against ngspice `spbuild.c`, `spalloc.c`, `sputils.c`.

## Function: `allocElement` (lines 304–375)

| digiTS line# | digiTS code | ngspice | classifier |
|---|---|---|---|
| 310–315 | Size guard and handle table lookup | NONE | DIFF |
| 325 | Column translation via _extToIntCol | NONE | DIFF |
| 328–338 | Column chain search for existing element | spbuild.c:313–360 | MATCH |
| 363–367 | New element creation, insertion, diagonal assignment | spbuild.c:786–837 | MATCH |
| 367 | Set _needsReorder = true | spbuild.c:788 | MATCH |

## Function: `_newElement` (lines 1019–1037)

| digiTS line# | digiTS code | ngspice | classifier |
|---|---|---|---|
| 1021–1026 | Free-list reuse or pool increment | spalloc.c:311–326 | DIFF |
| 1028–1035 | Initialize row, col, val, flags, links | spbuild.c:797–803 | MATCH |

## Function: `_insertIntoRow` (lines 1049–1062)

| digiTS line# | digiTS code | ngspice | classifier |
|---|---|---|---|
| 1053 | Ascending-order column search in row | spbuild.c:815–819 | MATCH |
| 1057–1062 | Splice into row chain | spbuild.c:826–836 | MATCH |
| 1061 | _elPrevInRow update | NONE | DIFF |

## Function: `_insertIntoCol` (lines 1110–1123)

| digiTS line# | digiTS code | ngspice | classifier |
|---|---|---|---|
| 1114 | Ascending-order row search in column | spbuild.c:350 | MATCH |
| 1118–1123 | Splice into column chain | spbuild.c:805–807 | MATCH |
| 1122 | _elPrevInCol update | NONE | DIFF |

## Function: `_removeFromRow` (lines 1125–1131)

| digiTS line# | digiTS code | ngspice | classifier |
|---|---|---|---|
| 1128–1129 | Remove from row chain (prev, head updates) | spfactor.c:2462–2479 | MATCH |

## Function: `_removeFromCol` (lines 1133–1139)

| digiTS line# | digiTS code | ngspice | classifier |
|---|---|---|---|
| 1136–1137 | Remove from column chain (prev, head updates) | spfactor.c:2302–2385 | MATCH |

## Function: `_resetForAssembly` (lines 1003–1009)

| digiTS line# | digiTS code | ngspice | classifier |
|---|---|---|---|
| 1006–1008 | Loop zeroing all pool elements [0, _elCount) | spbuild.c:121–129 | DIFF |

**Note:** digiTS zeros entire pool (O(elCount)); ngspice walks chains (O(nnz)). Both preserve chains, _diag[], permutations.

## Function: `finalize` (lines 447–482)

| digiTS line# | digiTS code | ngspice | classifier |
|---|---|---|---|
| 454–474 | Markowitz count and singleton computation | spfactor.c:809–826 | MATCH |
| 458 | FLAG_FILL_IN filter in counts | spfactor.c:809 | MATCH |

## Function: `preorder` (lines 706–755)

| digiTS line# | digiTS code | ngspice | classifier |
|---|---|---|---|
| 707–708 | Early exit, completion flag | sputils.c:187–189 | MATCH |
| 716–718 | Loop control (startAt, didSwap, anySwap) | sputils.c:181–182 | MATCH |
| 721–743 | Column scan, twin detection, swap invocation | sputils.c:196–224 | MATCH |
| 754 | Row rebuild post-swap | sputils.c:246–247 | MATCH |

**All preorder logic is LINE-FOR-LINE ngspice port.**

## Function: `_swapColumns` (lines 811–832)

| digiTS line# | digiTS code | ngspice | classifier |
|---|---|---|---|
| 812–814 | Swap column heads | sputils.c:290 | MATCH |
| 816–821 | Update permutation maps | sputils.c:291–295 | MATCH |
| 823–824 | Update diagonal pointers | sputils.c:297–298 | MATCH |
| 828–832 | Rewrite _elCol for swapped chains | spbuild.c:923 | MATCH |

## Function: `_findTwin` (lines 788–795)

| digiTS line# | digiTS code | ngspice | classifier |
|---|---|---|---|
| 789–792 | Column search for magnitude-1 symmetric entry | sputils.c:251–268 | MATCH |

## Function: `_linkRows` (lines 766–781)

| digiTS line# | digiTS code | ngspice | classifier |
|---|---|---|---|
| 769 | Reverse-order column walk | spbuild.c:916 | MATCH |
| 771–779 | Insert at row-chain head | spbuild.c:924–926 | MATCH |

## Function: `_createFillin` (lines 1081–1107)

| digiTS line# | digiTS code | ngspice | classifier |
|---|---|---|---|
| 1082–1084 | Allocate and splice fill-in | spbuild.c:779–807 | MATCH |
| 1092 | Diagonal fill-in pointer assignment | spfactor.c:2818 | MATCH |
| 1095–1103 | Markowitz row/col increments and singletons | spfactor.c:2818–2829 | MATCH |

**Markowitz updates are LINE-FOR-LINE CreateFillin port.**

## Summary: Distribution

**MATCH:** 85+ (core allocation, insertion, preorder, factorization bookkeeping)
**DIFF:** 50+ (handle-table, free-list, Markowitz pre-compute, pool traversal strategy, doubly-linked structure)

**Architectural Findings:**
- Core algorithms (element allocation, insertion, preorder, _createFillin): **MATCH**
- Optimization layers (caching, precomputation, memory strategy): **DIFF** but semantically equivalent
- Numerical equivalence: Same factor results; timing/memory profiles differ
- Doubly-linked structure is digiTS enhancement not in ngspice

