# Markowitz Pivoting — Line-for-Line ngspice Port

This document is the complete implementation bible for replacing our current Markowitz pivot search with a direct port of ngspice `spfactor.c`. **Every ngspice routine in the pivot-selection / row-col-exchange / Markowitz-bookkeeping path is reproduced verbatim below.** The implementation agent should not need to open `ref/ngspice/src/maths/sparse/spfactor.c` — every relevant byte is here. Our touchpoints in `src/solver/analog/sparse-solver.ts` are listed with current code, the change required, and the line ranges to replace.

The acceptance bar is **bit-exact L/U output vs ngspice** for any matrix where ngspice would pick the same pivot. The current implementation conflates row and column indexing in `_markowitzProd[]` and selects different pivots than ngspice when multiple singletons exist; this port closes that gap.

---

## 1. Scope

### In scope
- `SearchForPivot` dispatch (singleton → quick-diag → diag → entire-matrix)
- `SearchForSingleton`, `QuicklySearchDiagonal`, `SearchDiagonal`, `SearchEntireMatrix`
- `FindLargestInCol`, `FindBiggestInColExclude`
- `ExchangeRowsAndCols` and the row-permutation half it relies on
- `CountMarkowitz`, `MarkowitzProducts`, `UpdateMarkowitzNumbers`
- Whatever new fields are needed to make slot-indexing work (specifically the row-permutation arrays so `MarkowitzProd[]` can be slot-keyed)

### Out of scope
- The triangular-elimination loop (we use Gilbert-Peierls; ngspice uses `RealRowColElimination`). Our existing `_numericLUMarkowitz` body that scatters `x[]`, runs `_reach(k)`, performs the L solve, writes L/U entries, and stamps fill-ins **stays as is.** Only the pivot-search call site and the Markowitz bookkeeping change.
- The numeric-reuse path `_numericLUReusePivots` — it uses stored pivots, not pivot search.
- `solve()` — already applies `q[k]` / `pinv[r]` row permutation correctly.
- `preorder()` — symmetric-twin preorder is unrelated.
- Any UI, harness, or test changes.

### Non-negotiable

Per `CLAUDE.md`: this is an ngspice-correct port. No "pragmatic" alternatives, no skipping branches that look unreachable, no condensing two cases into one. Ports of `MAX_MARKOWITZ_TIES * TIES_MULTIPLIER` early-termination, the `Singletons--; ... Singletons++ on miss` speculation pattern, the `MarkowitzProd[Step-1] = 0 / -1` sentinel placement, and the `MarkowitzProd[Size+1] = MarkowitzProd[Step]` dual-purpose slot are mandatory. If something appears redundant in ngspice, it stays redundant in the port.

---

## 2. Indexing convention — ngspice 1-based vs ours 0-based

| ngspice | Ours | Meaning |
|---|---|---|
| `Step` ∈ [1, Size] | `step` (a.k.a. `k`) ∈ [0, n) | Current diagonal/elimination step |
| `Size` | `n - 1` (last valid step) or `n` (exclusive bound) | Matrix dimension |
| `MarkowitzProd[Step-1] = 0/-1` (sentinel below) | `mProd[step - 1]` only valid when `step ≥ 1` | Loop guard |
| `MarkowitzProd[Size+1] = MarkowitzProd[Step]` (dual-use slot) | Allocate `mProd` length `n + 2` so slot `[n]` and `[n+1]` are usable | Dual-purpose slot |
| `MarkowitzRow/Col[I]` for I ∈ [Step, Size] | Indexed by **physical slot** I ∈ [step, n) | See §3 |
| `Diag[I]` | `_diag[I]`, internal-col-keyed | Diagonal element of slot I (NULL if no nonzero) |
| `FirstInRow[I]` / `FirstInCol[I]` | `_rowHead[I]` / `_colHead[I]` | Linked-list head |
| `pElement->Row` | `_elRow[e]` | (See §3 — must be slot-keyed after row swaps) |
| `pElement->Col` | `_elCol[e]` (CURRENTLY original-col, must change) | (See §3) |
| `pElement->NextInRow` / `NextInCol` | `_elNextInRow[e]` / `_elNextInCol[e]` | Chain links |
| `IntToExtRowMap[I]` / `ExtToIntRowMap[r]` | **NEW** `_intToExtRow[I]` / `_extToIntRow[r]` | See §3 |
| `IntToExtColMap[I]` / `ExtToIntColMap[c]` | `_preorderColPerm[I]` / `_extToIntCol[c]` | Already present |
| `Matrix->Singletons` | `_singletons` | Count of slots I where `MarkowitzProd[I] == 0` |
| `Matrix->RelThreshold` / `AbsThreshold` | `_relThreshold` / `_absThreshold` | Thresholds |
| `ELEMENT_MAG(p)` | `Math.abs(_elVal[e])` | Magnitude (real-only) |
| `LARGEST_LONG_INTEGER` | `Number.MAX_SAFE_INTEGER` | Sentinel for `MinMarkowitzProduct` initial value |
| `MAX_MARKOWITZ_TIES` | Use ngspice value `100` | Tie-break cap |
| `TIES_MULTIPLIER` | Use ngspice value `5` | Tie-break cap multiplier |

`MAX_MARKOWITZ_TIES` and `TIES_MULTIPLIER` are defined in `spconfig.h`; copy the canonical constants:

```c
/* spconfig.h */
#define MAX_MARKOWITZ_TIES   100
#define TIES_MULTIPLIER      5
```

---

## 3. Architectural delta — physical row swap vs logical

ngspice physically swaps rows AND columns in the linked-list pool via `spcRowExchange` / `spcColExchange` so that, at every step `Step`, the chosen pivot has been moved to physical position `(Step, Step)`. This is what makes `MarkowitzRow[I]`, `MarkowitzCol[I]`, `MarkowitzProd[I]`, and `Diag[I]` all index the same `I` consistently — they all refer to "whatever is currently sitting at slot I".

Our solver:
- Already physically swaps **columns** via `_swapColumnsForPivot` (sparse-solver.ts:729).
- Has never physically swapped rows. Row pivoting is logical via `_pinv[origRow] = step` and `_q[step] = origRow`.

For the line-for-line port to produce ngspice's iteration order, we **must** maintain a row permutation that mirrors ngspice's `IntToExtRowMap`. There are two valid implementations:

**Option A — physical row swap** (true ngspice port). Reproduce `spcRowExchange` to physically move rows in the linked structure on every pivot step. Row indices stored on elements (`_elRow[e]`) become slot-keyed; the chain heads `_rowHead[I]` index into the slot at I.

**Option B — virtual row swap with translation layer.** Keep the linked-list rows in original-index space, but add `_intToExtRow[I]` and `_extToIntRow[r]` arrays that ngspice's pivot search consults to translate "slot I" ↔ "original row r". Every site that reads `pElement->Row` in the ngspice routines becomes `_extToIntRow[_elRow[e]]` (i.e. "what slot does this element's row currently occupy"). Every `Matrix->FirstInRow[I]` becomes `_rowHead[_intToExtRow[I]]` (i.e. "the chain for whatever row is currently at slot I").

**Implementation must use Option A.** Reasons: every ngspice routine below dereferences `pElement->Row` and compares to `Step` literally; replicating that with a translation layer in 6 routines × 5–10 sites each is fragile and the existing `pinv`/`q` already encode the same map for `solve()`. With physical row swap, `pElement->Row` directly equals the slot — same as ngspice. The implementation effort is the same as ngspice (`spcRowExchange` is ~50 lines).

After physical row swap:
- `_elRow[e]` semantically becomes "slot index", not "original row index". The originals are recovered via `_intToExtRow[slot]`.
- `_rowHead[I]` is the head of the chain at slot I.
- `_pinv` / `_q` collapse to identity (`q[step] = step`, `pinv[step] = step`) because the pivot row is **already** at slot `step` after `spcRowExchange`. They can be deleted, OR kept and set to identity post-port to minimise downstream change in `solve()`. **Decision: keep them, set to identity.** `solve()` already does `b[k] = rhs[q[k]]`; with `q[k] = k` post-port the row permutation comes from `_intToExtRow` (analog of `IntToExtRowMap`) instead. `solve()` reads RHS by original row, so it must use `_intToExtRow[k]` for the pivot map. **Update `solve()` accordingly — see §6.10.**

> Note: the `rhs[]` array is indexed by **original row** (the caller stamps RHS by original row index via `stampRHS`), so the translation in `solve()` is `b[k] = rhs[_intToExtRow[k]]`. After the port `_q[k] === _intToExtRow[k]` (they encode the same map by different names), so we can keep using `q[]` in `solve()` and just have `ExchangeRowsAndCols` write `q[step] = origRow; pinv[origRow] = step` at swap time. **This is the chosen wiring.**

---

## 4. ngspice source verbatim

Every routine reproduced from `ref/ngspice/src/maths/sparse/spfactor.c` (file paths in this repo's vendored copy). Comments are from ngspice and must be carried into the port.

### 4.1 SearchForPivot — dispatch (spfactor.c:947-994)

```c
static ElementPtr
SearchForPivot( MatrixPtr Matrix, int Step, int DiagPivoting )
{
    ElementPtr  ChosenPivot;

    /* Begin `SearchForPivot'. */

    /* If singletons exist, look for an acceptable one to use as pivot. */
    if (Matrix->Singletons) {
        ChosenPivot = SearchForSingleton( Matrix, Step );
        if (ChosenPivot != NULL) {
            Matrix->PivotSelectionMethod = 's';
            return ChosenPivot;
        }
    }

#if DIAGONAL_PIVOTING
    if (DiagPivoting) {
        /*
        * Either no singletons exist or they weren't acceptable.  Take quick first
        * pass at searching diagonal.  First search for element on diagonal of
        * remaining submatrix with smallest Markowitz product, then check to see
        * if it okay numerically.  If not, QuicklySearchDiagonal fails.
        */
        ChosenPivot = QuicklySearchDiagonal( Matrix, Step );
        if (ChosenPivot != NULL) {
            Matrix->PivotSelectionMethod = 'q';
            return ChosenPivot;
        }

        /*
        * Quick search of diagonal failed, carefully search diagonal and check each
        * pivot candidate numerically before even tentatively accepting it.
        */
        ChosenPivot = SearchDiagonal( Matrix, Step );
        if (ChosenPivot != NULL) {
            Matrix->PivotSelectionMethod = 'd';
            return ChosenPivot;
        }
    }
#endif /* DIAGONAL_PIVOTING */

    /* No acceptable pivot found yet, search entire matrix. */
    ChosenPivot = SearchEntireMatrix( Matrix, Step );
    Matrix->PivotSelectionMethod = 'e';

    return ChosenPivot;
}
```

`DIAGONAL_PIVOTING` and `MODIFIED_MARKOWITZ` are both **ON** by default in `spconfig.h`. `DiagPivoting` flag is true by default (`DIAG_PIVOTING_AS_DEFAULT`). Port both `#if` branches as live code.

### 4.2 SearchForSingleton (spfactor.c:1041-1172)

```c
static ElementPtr
SearchForSingleton( MatrixPtr Matrix, int Step )
{
    ElementPtr  ChosenPivot;
    int  I;
    long  *pMarkowitzProduct;
    int  Singletons;
    RealNumber  PivotMag;

    /* Begin `SearchForSingleton'. */
    /* Initialize pointer that is to scan through MarkowitzProduct vector. */
    pMarkowitzProduct = &(Matrix->MarkowitzProd[Matrix->Size+1]);
    Matrix->MarkowitzProd[Matrix->Size+1] = Matrix->MarkowitzProd[Step];

    /* Decrement the count of available singletons, on the assumption that an
    * acceptable one will be found. */
    Singletons = Matrix->Singletons--;

    /*
    * Assure that following while loop will always terminate, this is just
    * preventive medicine, if things are working right this should never
    * be needed.
    */
    Matrix->MarkowitzProd[Step-1] = 0;

    while (Singletons-- > 0) {
        /* Singletons exist, find them. */

        /*
        * This is tricky.  Am using a pointer to sequentially step through the
        * MarkowitzProduct array.  Search terminates when singleton (Product = 0)
        * is found.  Note that the conditional in the while statement
        * ( *pMarkowitzProduct ) is TRUE as long as the MarkowitzProduct is not
        * equal to zero.  The row (and column)strchr on the diagonal is then
        * calculated by subtracting the pointer to the Markowitz product of
        * the first diagonal from the pointer to the Markowitz product of the
        * desired element, the singleton.
        *
        * Search proceeds from the end (high row and column numbers) to the
        * beginning (low row and column numbers) so that rows and columns with
        * large Markowitz products will tend to be move to the bottom of the
        * matrix.  However, choosing Diag[Step] is desirable because it would
        * require no row and column interchanges, so inspect it first by
        * putting its Markowitz product at the end of the MarkowitzProd
        * vector.
        */

        while ( *pMarkowitzProduct-- ) {
            /*
                     * N bottles of beer on the wall;
                     * N bottles of beer.
                     * you take one down and pass it around;
                     * N-1 bottles of beer on the wall.
                     */
        }
        I = (int)(pMarkowitzProduct - Matrix->MarkowitzProd) + 1;

        /* Assure that I is valid. */
        if (I < Step) break;  /* while (Singletons-- > 0) */
        if (I > Matrix->Size) I = Step;

        /* Singleton has been found in either/both row or/and column I. */
        if ((ChosenPivot = Matrix->Diag[I]) != NULL) {
            /* Singleton lies on the diagonal. */
            PivotMag = ELEMENT_MAG(ChosenPivot);
            if
            (    PivotMag > Matrix->AbsThreshold &&
                    PivotMag > Matrix->RelThreshold *
                    FindBiggestInColExclude( Matrix, ChosenPivot, Step )
            ) return ChosenPivot;
        } else {
            /* Singleton does not lie on diagonal, find it. */
            if (Matrix->MarkowitzCol[I] == 0) {
                ChosenPivot = Matrix->FirstInCol[I];
                while ((ChosenPivot != NULL) && (ChosenPivot->Row < Step))
                    ChosenPivot = ChosenPivot->NextInCol;
                if (ChosenPivot != NULL) {
                    /* Reduced column has no elements, matrix is singular. */
                    break;
                }
                PivotMag = ELEMENT_MAG(ChosenPivot);
                if
                (    PivotMag > Matrix->AbsThreshold &&
                        PivotMag > Matrix->RelThreshold *
                        FindBiggestInColExclude( Matrix, ChosenPivot,
                                                 Step )
                ) return ChosenPivot;
                else {
                    if (Matrix->MarkowitzRow[I] == 0) {
                        ChosenPivot = Matrix->FirstInRow[I];
                        while((ChosenPivot != NULL) && (ChosenPivot->Col<Step))
                            ChosenPivot = ChosenPivot->NextInRow;
                        if (ChosenPivot != NULL) {
                            /* Reduced row has no elements, matrix is singular. */
                            break;
                        }
                        PivotMag = ELEMENT_MAG(ChosenPivot);
                        if
                        (    PivotMag > Matrix->AbsThreshold &&
                                PivotMag > Matrix->RelThreshold *
                                FindBiggestInColExclude( Matrix,
                                                         ChosenPivot,
                                                         Step )
                        ) return ChosenPivot;
                    }
                }
            } else {
                ChosenPivot = Matrix->FirstInRow[I];
                while ((ChosenPivot != NULL) && (ChosenPivot->Col < Step))
                    ChosenPivot = ChosenPivot->NextInRow;
                if (ChosenPivot != NULL) {
                    /* Reduced row has no elements, matrix is singular. */
                    break;
                }
                PivotMag = ELEMENT_MAG(ChosenPivot);
                if
                (    PivotMag > Matrix->AbsThreshold &&
                        PivotMag > Matrix->RelThreshold *
                        FindBiggestInColExclude( Matrix, ChosenPivot,
                                                 Step )
                ) return ChosenPivot;
            }
        }
        /* Singleton not acceptable (too small), try another. */
    } /* end of while(lSingletons>0) */

    /*
    * All singletons were unacceptable.  Restore Matrix->Singletons count.
    * Initial assumption that an acceptable singleton would be found was wrong.
    */
    Matrix->Singletons++;
    return NULL;
}
```

> **Note** — the comments at lines 1116-1119 / 1132-1135 / 1150-1153 say "Reduced column has no elements, matrix is singular" inside `if (ChosenPivot != NULL) { break; }`. That is a **bug** in the ngspice comments — the condition is `ChosenPivot != NULL` but the comment claims "no elements". The actual ngspice behaviour: when `ChosenPivot != NULL`, the singleton scan terminates the outer `while`. We carry the same bug — line-for-line — including the misleading comment. Do not "fix" it.

### 4.3 QuicklySearchDiagonal — MODIFIED_MARKOWITZ branch (spfactor.c:1255-1383)

```c
static ElementPtr
QuicklySearchDiagonal( MatrixPtr Matrix, int Step )
{
    long  MinMarkowitzProduct, *pMarkowitzProduct;
    ElementPtr  pDiag, pOtherInRow, pOtherInCol;
    int  I, NumberOfTies;
    ElementPtr  ChosenPivot, TiedElements[MAX_MARKOWITZ_TIES + 1];
    RealNumber  Magnitude, LargestInCol, Ratio, MaxRatio;
    RealNumber  LargestOffDiagonal;
    RealNumber  FindBiggestInColExclude();

    /* Begin `QuicklySearchDiagonal'. */
    NumberOfTies = -1;
    MinMarkowitzProduct = LARGEST_LONG_INTEGER;
    pMarkowitzProduct = &(Matrix->MarkowitzProd[Matrix->Size+2]);
    Matrix->MarkowitzProd[Matrix->Size+1] = Matrix->MarkowitzProd[Step];

    /* Assure that following while loop will always terminate. */
    Matrix->MarkowitzProd[Step-1] = -1;

    /*
    * This is tricky.  Am using a pointer in the inner while loop to
    * sequentially step through the MarkowitzProduct array.  Search
    * terminates when the Markowitz product of zero placed at location
    * Step-1 is found.  The row (and column)strchr on the diagonal is then
    * calculated by subtracting the pointer to the Markowitz product of
    * the first diagonal from the pointer to the Markowitz product of the
    * desired element. The outer for loop is infinite, broken by using
    * break.
    *
    * Search proceeds from the end (high row and column numbers) to the
    * beginning (low row and column numbers) so that rows and columns with
    * large Markowitz products will tend to be move to the bottom of the
    * matrix.  However, choosing Diag[Step] is desirable because it would
    * require no row and column interchanges, so inspect it first by
    * putting its Markowitz product at the end of the MarkowitzProd
    * vector.
    */

    for(;;) { /* Endless for loop. */
        while (MinMarkowitzProduct < *(--pMarkowitzProduct)) {
            /*
                     * N bottles of beer on the wall;
                     * N bottles of beer.
                     * You take one down and pass it around;
                     * N-1 bottles of beer on the wall.
                     */
        }

        I = pMarkowitzProduct - Matrix->MarkowitzProd;

        /* Assure that I is valid; if I < Step, terminate search. */
        if (I < Step) break; /* Endless for loop */
        if (I > Matrix->Size) I = Step;

        if ((pDiag = Matrix->Diag[I]) == NULL)
            continue; /* Endless for loop */
        if ((Magnitude = ELEMENT_MAG(pDiag)) <= Matrix->AbsThreshold)
            continue; /* Endless for loop */

        if (*pMarkowitzProduct == 1) {
            /* Case where only one element exists in row and column other than diagonal. */

            /* Find off diagonal elements. */
            pOtherInRow = pDiag->NextInRow;
            pOtherInCol = pDiag->NextInCol;
            if (pOtherInRow == NULL && pOtherInCol == NULL) {
                pOtherInRow = Matrix->FirstInRow[I];
                while(pOtherInRow != NULL) {
                    if (pOtherInRow->Col >= Step && pOtherInRow->Col != I)
                        break;
                    pOtherInRow = pOtherInRow->NextInRow;
                }
                pOtherInCol = Matrix->FirstInCol[I];
                while(pOtherInCol != NULL) {
                    if (pOtherInCol->Row >= Step && pOtherInCol->Row != I)
                        break;
                    pOtherInCol = pOtherInCol->NextInCol;
                }
            }

            /* Accept diagonal as pivot if diagonal is larger than off diagonals and the
            * off diagonals are placed symmetricly. */
            if (pOtherInRow != NULL  &&  pOtherInCol != NULL) {
                if (pOtherInRow->Col == pOtherInCol->Row) {
                    LargestOffDiagonal = MAX(ELEMENT_MAG(pOtherInRow),
                                             ELEMENT_MAG(pOtherInCol));
                    if (Magnitude >= LargestOffDiagonal) {
                        /* Accept pivot, it is unlikely to contribute excess error. */
                        return pDiag;
                    }
                }
            }
        }

        if (*pMarkowitzProduct < MinMarkowitzProduct) {
            /* Notice strict inequality in test. This is a new smallest MarkowitzProduct. */
            TiedElements[0] = pDiag;
            MinMarkowitzProduct = *pMarkowitzProduct;
            NumberOfTies = 0;
        } else {
            /* This case handles Markowitz ties. */
            if (NumberOfTies < MAX_MARKOWITZ_TIES) {
                TiedElements[++NumberOfTies] = pDiag;
                if (NumberOfTies >= MinMarkowitzProduct * TIES_MULTIPLIER)
                    break; /* Endless for loop */
            }
        }
    } /* End of endless for loop. */

    /* Test to see if any element was chosen as a pivot candidate. */
    if (NumberOfTies < 0)
        return NULL;

    /* Determine which of tied elements is best numerically. */
    ChosenPivot = NULL;
    MaxRatio = 1.0 / Matrix->RelThreshold;

    for (I = 0; I <= NumberOfTies; I++) {
        pDiag = TiedElements[I];
        Magnitude = ELEMENT_MAG(pDiag);
        LargestInCol = FindBiggestInColExclude( Matrix, pDiag, Step );
        Ratio = LargestInCol / Magnitude;
        if (Ratio < MaxRatio) {
            ChosenPivot = pDiag;
            MaxRatio = Ratio;
        }
    }
    return ChosenPivot;
}
```

> Use the `MODIFIED_MARKOWITZ` branch above. The non-MODIFIED version at spfactor.c:1445-1543 must NOT be ported — `MODIFIED_MARKOWITZ` is on by default in `spconfig.h`.

### 4.4 SearchDiagonal (spfactor.c:1604-1663)

```c
static ElementPtr
SearchDiagonal( MatrixPtr Matrix, int Step )
{
    int  J;
    long  MinMarkowitzProduct, *pMarkowitzProduct;
    int  I;
    ElementPtr  pDiag;
    int  NumberOfTies = 0;
    int  Size = Matrix->Size;

    ElementPtr  ChosenPivot;
    RealNumber  Magnitude, Ratio;
    RealNumber  RatioOfAccepted = 0;
    RealNumber  LargestInCol;

    /* Begin `SearchDiagonal'. */
    ChosenPivot = NULL;
    MinMarkowitzProduct = LARGEST_LONG_INTEGER;
    pMarkowitzProduct = &(Matrix->MarkowitzProd[Size+2]);
    Matrix->MarkowitzProd[Size+1] = Matrix->MarkowitzProd[Step];

    /* Start search of diagonal. */
    for (J = Size+1; J > Step; J--) {
        if (*(--pMarkowitzProduct) > MinMarkowitzProduct)
            continue; /* for loop */
        if (J > Matrix->Size)
            I = Step;
        else
            I = J;
        if ((pDiag = Matrix->Diag[I]) == NULL)
            continue; /* for loop */
        if ((Magnitude = ELEMENT_MAG(pDiag)) <= Matrix->AbsThreshold)
            continue; /* for loop */

        /* Test to see if diagonal's magnitude is acceptable. */
        LargestInCol = FindBiggestInColExclude( Matrix, pDiag, Step );
        if (Magnitude <= Matrix->RelThreshold * LargestInCol)
            continue; /* for loop */

        if (*pMarkowitzProduct < MinMarkowitzProduct) {
            /* Notice strict inequality in test. This is a new
                   smallest MarkowitzProduct. */
            ChosenPivot = pDiag;
            MinMarkowitzProduct = *pMarkowitzProduct;
            RatioOfAccepted = LargestInCol / Magnitude;
            NumberOfTies = 0;
        } else {
            /* This case handles Markowitz ties. */
            NumberOfTies++;
            Ratio = LargestInCol / Magnitude;
            if (Ratio < RatioOfAccepted) {
                ChosenPivot = pDiag;
                RatioOfAccepted = Ratio;
            }
            if (NumberOfTies >= MinMarkowitzProduct * TIES_MULTIPLIER)
                return ChosenPivot;
        }
    } /* End of for(Step) */
    return ChosenPivot;
}
```

### 4.5 SearchEntireMatrix (spfactor.c:1730-1809)

```c
static ElementPtr
SearchEntireMatrix( MatrixPtr Matrix, int Step )
{
    int  I, Size = Matrix->Size;
    ElementPtr  pElement;
    int  NumberOfTies = 0;
    long  Product, MinMarkowitzProduct;
    ElementPtr  ChosenPivot;
    ElementPtr  pLargestElement = NULL;
    RealNumber  Magnitude, LargestElementMag, Ratio;
    RealNumber  RatioOfAccepted = 0;
    RealNumber  LargestInCol;

    /* Begin `SearchEntireMatrix'. */
    ChosenPivot = NULL;
    LargestElementMag = 0.0;
    MinMarkowitzProduct = LARGEST_LONG_INTEGER;

    /* Start search of matrix on column by column basis. */
    for (I = Step; I <= Size; I++) {
        pElement = Matrix->FirstInCol[I];

        while (pElement != NULL && pElement->Row < Step)
            pElement = pElement->NextInCol;

        if((LargestInCol = FindLargestInCol(pElement)) == 0.0)
            continue; /* for loop */

        while (pElement != NULL) {
            /* Check to see if element is the largest encountered so
               far.  If so, record its magnitude and address. */
            if ((Magnitude = ELEMENT_MAG(pElement)) > LargestElementMag) {
                LargestElementMag = Magnitude;
                pLargestElement = pElement;
            }
            /* Calculate element's MarkowitzProduct. */
            Product = Matrix->MarkowitzRow[pElement->Row] *
                      Matrix->MarkowitzCol[pElement->Col];

            /* Test to see if element is acceptable as a pivot
                   candidate. */
            if ((Product <= MinMarkowitzProduct) &&
                    (Magnitude > Matrix->RelThreshold * LargestInCol) &&
                    (Magnitude > Matrix->AbsThreshold)) {
                /* Test to see if element has lowest MarkowitzProduct
                   yet found, or whether it is tied with an element
                   found earlier. */
                if (Product < MinMarkowitzProduct) {
                    /* Notice strict inequality in test. This is a new
                               smallest MarkowitzProduct. */
                    ChosenPivot = pElement;
                    MinMarkowitzProduct = Product;
                    RatioOfAccepted = LargestInCol / Magnitude;
                    NumberOfTies = 0;
                } else {
                    /* This case handles Markowitz ties. */
                    NumberOfTies++;
                    Ratio = LargestInCol / Magnitude;
                    if (Ratio < RatioOfAccepted) {
                        ChosenPivot = pElement;
                        RatioOfAccepted = Ratio;
                    }
                    if (NumberOfTies >= MinMarkowitzProduct * TIES_MULTIPLIER)
                        return ChosenPivot;
                }
            }
            pElement = pElement->NextInCol;
        }  /* End of while(pElement != NULL) */
    } /* End of for(Step) */

    if (ChosenPivot != NULL) return ChosenPivot;

    if (LargestElementMag == 0.0) {
        Matrix->Error = spSINGULAR;
        return NULL;
    }

    Matrix->Error = spSMALL_PIVOT;
    return pLargestElement;
}
```

### 4.6 FindLargestInCol (spfactor.c:1849-1863)

```c
static RealNumber
FindLargestInCol( ElementPtr pElement )
{
    RealNumber  Magnitude, Largest = 0.0;

    /* Begin `FindLargestInCol'. */
    /* Search column for largest element beginning at Element. */
    while (pElement != NULL) {
        if ((Magnitude = ELEMENT_MAG(pElement)) > Largest)
            Largest = Magnitude;
        pElement = pElement->NextInCol;
    }

    return Largest;
}
```

### 4.7 FindBiggestInColExclude (spfactor.c:1913-1944)

```c
static RealNumber
FindBiggestInColExclude( MatrixPtr Matrix, ElementPtr pElement, int Step )
{
    int  Row;
    int  Col;
    RealNumber  Largest, Magnitude;

    /* Begin `FindBiggestInColExclude'. */
    Row = pElement->Row;
    Col = pElement->Col;
    pElement = Matrix->FirstInCol[Col];

    /* Travel down column until reduced submatrix is entered. */
    while ((pElement != NULL) && (pElement->Row < Step))
        pElement = pElement->NextInCol;

    /* Initialize the variable Largest. */
    if (pElement->Row != Row)
        Largest = ELEMENT_MAG(pElement);
    else
        Largest = 0.0;

    /* Search rest of column for largest element, avoiding excluded element. */
    while ((pElement = pElement->NextInCol) != NULL) {
        if ((Magnitude = ELEMENT_MAG(pElement)) > Largest) {
            if (pElement->Row != Row)
                Largest = Magnitude;
        }
    }

    return Largest;
}
```

### 4.8 ExchangeRowsAndCols (spfactor.c:1986-2070)

```c
static void
ExchangeRowsAndCols( MatrixPtr Matrix, ElementPtr pPivot, int Step )
{
    int   Row, Col;
    long  OldMarkowitzProd_Step, OldMarkowitzProd_Row, OldMarkowitzProd_Col;

    /* Begin `ExchangeRowsAndCols'. */
    Row = pPivot->Row;
    Col = pPivot->Col;
    Matrix->PivotsOriginalRow = Row;
    Matrix->PivotsOriginalCol = Col;

    if ((Row == Step) && (Col == Step)) return;

    /* Exchange rows and columns. */
    if (Row == Col) {
        spcRowExchange( Matrix, Step, Row );
        spcColExchange( Matrix, Step, Col );
        SWAP( long, Matrix->MarkowitzProd[Step], Matrix->MarkowitzProd[Row] );
        SWAP( ElementPtr, Matrix->Diag[Row], Matrix->Diag[Step] );
    } else {

        /* Initialize variables that hold old Markowitz products. */
        OldMarkowitzProd_Step = Matrix->MarkowitzProd[Step];
        OldMarkowitzProd_Row = Matrix->MarkowitzProd[Row];
        OldMarkowitzProd_Col = Matrix->MarkowitzProd[Col];

        /* Exchange rows. */
        if (Row != Step) {
            spcRowExchange( Matrix, Step, Row );
            Matrix->NumberOfInterchangesIsOdd =
                !Matrix->NumberOfInterchangesIsOdd;
            Matrix->MarkowitzProd[Row] = Matrix->MarkowitzRow[Row] *
                                         Matrix->MarkowitzCol[Row];

            /* Update singleton count. */
            if ((Matrix->MarkowitzProd[Row]==0) != (OldMarkowitzProd_Row==0)) {
                if (OldMarkowitzProd_Row == 0)
                    Matrix->Singletons--;
                else
                    Matrix->Singletons++;
            }
        }

        /* Exchange columns. */
        if (Col != Step) {
            spcColExchange( Matrix, Step, Col );
            Matrix->NumberOfInterchangesIsOdd =
                !Matrix->NumberOfInterchangesIsOdd;
            Matrix->MarkowitzProd[Col] = Matrix->MarkowitzCol[Col] *
                                         Matrix->MarkowitzRow[Col];

            /* Update singleton count. */
            if ((Matrix->MarkowitzProd[Col]==0) != (OldMarkowitzProd_Col==0)) {
                if (OldMarkowitzProd_Col == 0)
                    Matrix->Singletons--;
                else
                    Matrix->Singletons++;
            }

            Matrix->Diag[Col] = spcFindElementInCol( Matrix,
                                Matrix->FirstInCol+Col,
                                Col, Col, NO );
        }
        if (Row != Step) {
            Matrix->Diag[Row] = spcFindElementInCol( Matrix,
                                Matrix->FirstInCol+Row,
                                Row, Row, NO );
        }
        Matrix->Diag[Step] = spcFindElementInCol( Matrix,
                             Matrix->FirstInCol+Step,
                             Step, Step, NO );

        /* Update singleton count. */
        Matrix->MarkowitzProd[Step] = Matrix->MarkowitzCol[Step] *
                                      Matrix->MarkowitzRow[Step];
        if ((Matrix->MarkowitzProd[Step]==0) != (OldMarkowitzProd_Step==0)) {
            if (OldMarkowitzProd_Step == 0)
                Matrix->Singletons--;
            else
                Matrix->Singletons++;
        }
    }
    return;
}
```

`spcFindElementInCol` is a one-liner: walk `FirstInCol[Col]` looking for `Row == r`; return that element or NULL. Equivalent to our existing `_findDiagOnColumn` but with the row arg `Col` rather than `_preorderColPerm[internalCol]`. After the row physical swap, the diagonal element of slot I is the one at `(I, I)` — the `r == c` condition.

`NumberOfInterchangesIsOdd` is unused outside `spDeterminant`; we have no determinant routine. Skip the toggle (or carry it as a no-op `_oddInterchanges` boolean for parity-completeness — matter of taste; agent decides; it's the only line without functional impact).

`PivotsOriginalRow` / `PivotsOriginalCol` are used by the elimination routine to remember "what was just moved". For our Gilbert-Peierls elimination they are unused; skip.

### 4.9 spcRowExchange (spfactor.c:2110-2164)

```c
void
spcRowExchange( MatrixPtr Matrix, int Row1, int Row2 )
{
    ElementPtr  Row1Ptr, Row2Ptr;
    int  Column;
    ElementPtr  Element1, Element2;

    /* Begin `spcRowExchange'. */
    if (Row1 > Row2)  SWAP(int, Row1, Row2);

    Row1Ptr = Matrix->FirstInRow[Row1];
    Row2Ptr = Matrix->FirstInRow[Row2];
    while (Row1Ptr != NULL || Row2Ptr != NULL) {
        /* Exchange elements in rows while traveling from left to right. */
        if (Row1Ptr == NULL) {
            Column = Row2Ptr->Col;
            Element1 = NULL;
            Element2 = Row2Ptr;
            Row2Ptr = Row2Ptr->NextInRow;
        } else if (Row2Ptr == NULL) {
            Column = Row1Ptr->Col;
            Element1 = Row1Ptr;
            Element2 = NULL;
            Row1Ptr = Row1Ptr->NextInRow;
        } else if (Row1Ptr->Col < Row2Ptr->Col) {
            Column = Row1Ptr->Col;
            Element1 = Row1Ptr;
            Element2 = NULL;
            Row1Ptr = Row1Ptr->NextInRow;
        } else if (Row1Ptr->Col > Row2Ptr->Col) {
            Column = Row2Ptr->Col;
            Element1 = NULL;
            Element2 = Row2Ptr;
            Row2Ptr = Row2Ptr->NextInRow;
        } else { /* Row1Ptr->Col == Row2Ptr->Col */
            Column = Row1Ptr->Col;
            Element1 = Row1Ptr;
            Element2 = Row2Ptr;
            Row1Ptr = Row1Ptr->NextInRow;
            Row2Ptr = Row2Ptr->NextInRow;
        }

        ExchangeColElements( Matrix, Row1, Element1, Row2, Element2, Column);
    }  /* end of while(Row1Ptr != NULL || Row2Ptr != NULL) */

    if (Matrix->InternalVectorsAllocated)
        SWAP( int, Matrix->MarkowitzRow[Row1], Matrix->MarkowitzRow[Row2]);
    SWAP( ElementPtr, Matrix->FirstInRow[Row1], Matrix->FirstInRow[Row2]);
    SWAP( int, Matrix->IntToExtRowMap[Row1], Matrix->IntToExtRowMap[Row2]);
#if TRANSLATE
    Matrix->ExtToIntRowMap[ Matrix->IntToExtRowMap[Row1] ] = Row1;
    Matrix->ExtToIntRowMap[ Matrix->IntToExtRowMap[Row2] ] = Row2;
#endif

    return;
}
```

`InternalVectorsAllocated` is always true by the time we hit pivot search (we allocate `_markowitzRow` in `_initStructure`). Drop the guard. `TRANSLATE` is on; port both `IntToExtRowMap` and `ExtToIntRowMap` updates.

### 4.10 spcColExchange (spfactor.c:2204-2258)

```c
void
spcColExchange( MatrixPtr Matrix, int Col1, int Col2 )
{
    ElementPtr  Col1Ptr, Col2Ptr;
    int  Row;
    ElementPtr  Element1, Element2;

    /* Begin `spcColExchange'. */
    if (Col1 > Col2)  SWAP(int, Col1, Col2);

    Col1Ptr = Matrix->FirstInCol[Col1];
    Col2Ptr = Matrix->FirstInCol[Col2];
    while (Col1Ptr != NULL || Col2Ptr != NULL) {
        /* Exchange elements in rows while traveling from top to bottom. */
        if (Col1Ptr == NULL) {
            Row = Col2Ptr->Row;
            Element1 = NULL;
            Element2 = Col2Ptr;
            Col2Ptr = Col2Ptr->NextInCol;
        } else if (Col2Ptr == NULL) {
            Row = Col1Ptr->Row;
            Element1 = Col1Ptr;
            Element2 = NULL;
            Col1Ptr = Col1Ptr->NextInCol;
        } else if (Col1Ptr->Row < Col2Ptr->Row) {
            Row = Col1Ptr->Row;
            Element1 = Col1Ptr;
            Element2 = NULL;
            Col1Ptr = Col1Ptr->NextInCol;
        } else if (Col1Ptr->Row > Col2Ptr->Row) {
            Row = Col2Ptr->Row;
            Element1 = NULL;
            Element2 = Col2Ptr;
            Col2Ptr = Col2Ptr->NextInCol;
        } else { /* Col1Ptr->Row == Col2Ptr->Row */
            Row = Col1Ptr->Row;
            Element1 = Col1Ptr;
            Element2 = Col2Ptr;
            Col1Ptr = Col1Ptr->NextInCol;
            Col2Ptr = Col2Ptr->NextInCol;
        }

        ExchangeRowElements( Matrix, Col1, Element1, Col2, Element2, Row);
    }  /* end of while(Col1Ptr != NULL || Col2Ptr != NULL) */

    if (Matrix->InternalVectorsAllocated)
        SWAP( int, Matrix->MarkowitzCol[Col1], Matrix->MarkowitzCol[Col2]);
    SWAP( ElementPtr, Matrix->FirstInCol[Col1], Matrix->FirstInCol[Col2]);
    SWAP( int, Matrix->IntToExtColMap[Col1], Matrix->IntToExtColMap[Col2]);
#if TRANSLATE
    Matrix->ExtToIntColMap[ Matrix->IntToExtColMap[Col1] ] = Col1;
    Matrix->ExtToIntColMap[ Matrix->IntToExtColMap[Col2] ] = Col2;
#endif

    return;
}
```

> **Important:** our existing `_swapColumnsForPivot` (sparse-solver.ts:729) does NOT walk the row chains via `ExchangeRowElements`. It only swaps `_colHead[]`. **That's broken** for the post-port world: `pElement->Col` must equal the slot the column currently sits in, so after a column swap, every element in the affected columns needs its `_elCol[e]` updated and its position in the row chain re-threaded. The replacement is `spcColExchange` exactly as written above — it walks both columns top-to-bottom and uses `ExchangeRowElements` at every row that has at least one of the two columns nonzero.

### 4.11 ExchangeColElements (spfactor.c:2302-2385)

```c
static void
ExchangeColElements( MatrixPtr Matrix, int Row1, ElementPtr Element1, int Row2, ElementPtr Element2, int Column )
{
    ElementPtr  *ElementAboveRow1, *ElementAboveRow2;
    ElementPtr  ElementBelowRow1, ElementBelowRow2;
    ElementPtr  pElement;

    /* Begin `ExchangeColElements'. */
    /* Search to find the ElementAboveRow1. */
    ElementAboveRow1 = &(Matrix->FirstInCol[Column]);
    pElement = *ElementAboveRow1;
    while (pElement->Row < Row1) {
        ElementAboveRow1 = &(pElement->NextInCol);
        pElement = *ElementAboveRow1;
    }
    if (Element1 != NULL) {
        ElementBelowRow1 = Element1->NextInCol;
        if (Element2 == NULL) {
            /* Element2 does not exist, move Element1 down to Row2. */
            if ( ElementBelowRow1 != NULL && ElementBelowRow1->Row < Row2 ) {
                /* Element1 must be removed from linked list and moved. */
                *ElementAboveRow1 = ElementBelowRow1;

                /* Search column for Row2. */
                pElement = ElementBelowRow1;
                do {
                    ElementAboveRow2 = &(pElement->NextInCol);
                    pElement = *ElementAboveRow2;
                }   while (pElement != NULL && pElement->Row < Row2);

                /* Place Element1 in Row2. */
                *ElementAboveRow2 = Element1;
                Element1->NextInCol = pElement;
                *ElementAboveRow1 =ElementBelowRow1;
            }
            Element1->Row = Row2;
        } else {
            /* Element2 does exist, and the two elements must be exchanged. */
            if ( ElementBelowRow1->Row == Row2) {
                /* Element2 is just below Element1, exchange them. */
                Element1->NextInCol = Element2->NextInCol;
                Element2->NextInCol = Element1;
                *ElementAboveRow1 = Element2;
            } else {
                /* Element2 is not just below Element1 and must be searched for. */
                pElement = ElementBelowRow1;
                do {
                    ElementAboveRow2 = &(pElement->NextInCol);
                    pElement = *ElementAboveRow2;
                }   while (pElement->Row < Row2);

                ElementBelowRow2 = Element2->NextInCol;

                /* Switch Element1 and Element2. */
                *ElementAboveRow1 = Element2;
                Element2->NextInCol = ElementBelowRow1;
                *ElementAboveRow2 = Element1;
                Element1->NextInCol = ElementBelowRow2;
            }
            Element1->Row = Row2;
            Element2->Row = Row1;
        }
    } else {
        /* Element1 does not exist. */
        ElementBelowRow1 = pElement;

        /* Find Element2. */
        if (ElementBelowRow1->Row != Row2) {
            do {
                ElementAboveRow2 = &(pElement->NextInCol);
                pElement = *ElementAboveRow2;
            }   while (pElement->Row < Row2);

            ElementBelowRow2 = Element2->NextInCol;

            /* Move Element2 to Row1. */
            *ElementAboveRow2 = Element2->NextInCol;
            *ElementAboveRow1 = Element2;
            Element2->NextInCol = ElementBelowRow1;
        }
        Element2->Row = Row1;
    }
    return;
}
```

> **Linked-list field note:** ngspice uses singly linked lists (only `NextInCol`, no `PrevInCol`). Our solver uses **doubly-linked** lists (`_elNextInCol` AND `_elPrevInCol`). The port must update both directions. Wherever ngspice writes `*ElementAboveRow1 = X`, the equivalent in our doubly-linked structure is "set `_elNextInCol[prev] = X` AND `_elPrevInCol[X] = prev`". When ngspice writes `Element->NextInCol = Y`, we also write `_elPrevInCol[Y] = Element`. Use a small helper `_spliceCol(prev, curr, next)` that maintains both links to avoid mistakes.

### 4.12 ExchangeRowElements (spfactor.c:2431-2514)

```c
static void
ExchangeRowElements( MatrixPtr Matrix, int Col1, ElementPtr Element1, int Col2, ElementPtr Element2, int Row )
{
    ElementPtr  *ElementLeftOfCol1, *ElementLeftOfCol2;
    ElementPtr  ElementRightOfCol1, ElementRightOfCol2;
    ElementPtr  pElement;

    /* Begin `ExchangeRowElements'. */
    /* Search to find the ElementLeftOfCol1. */
    ElementLeftOfCol1 = &(Matrix->FirstInRow[Row]);
    pElement = *ElementLeftOfCol1;
    while (pElement->Col < Col1) {
        ElementLeftOfCol1 = &(pElement->NextInRow);
        pElement = *ElementLeftOfCol1;
    }
    if (Element1 != NULL) {
        ElementRightOfCol1 = Element1->NextInRow;
        if (Element2 == NULL) {
            /* Element2 does not exist, move Element1 to right to Col2. */
            if ( ElementRightOfCol1 != NULL && ElementRightOfCol1->Col < Col2 ) {
                /* Element1 must be removed from linked list and moved. */
                *ElementLeftOfCol1 = ElementRightOfCol1;

                /* Search Row for Col2. */
                pElement = ElementRightOfCol1;
                do {
                    ElementLeftOfCol2 = &(pElement->NextInRow);
                    pElement = *ElementLeftOfCol2;
                }   while (pElement != NULL && pElement->Col < Col2);

                /* Place Element1 in Col2. */
                *ElementLeftOfCol2 = Element1;
                Element1->NextInRow = pElement;
                *ElementLeftOfCol1 =ElementRightOfCol1;
            }
            Element1->Col = Col2;
        } else {
            /* Element2 does exist, and the two elements must be exchanged. */
            if ( ElementRightOfCol1->Col == Col2) {
                /* Element2 is just right of Element1, exchange them. */
                Element1->NextInRow = Element2->NextInRow;
                Element2->NextInRow = Element1;
                *ElementLeftOfCol1 = Element2;
            } else {
                /* Element2 is not just right of Element1 and must be searched for. */
                pElement = ElementRightOfCol1;
                do {
                    ElementLeftOfCol2 = &(pElement->NextInRow);
                    pElement = *ElementLeftOfCol2;
                }   while (pElement->Col < Col2);

                ElementRightOfCol2 = Element2->NextInRow;

                /* Switch Element1 and Element2. */
                *ElementLeftOfCol1 = Element2;
                Element2->NextInRow = ElementRightOfCol1;
                *ElementLeftOfCol2 = Element1;
                Element1->NextInRow = ElementRightOfCol2;
            }
            Element1->Col = Col2;
            Element2->Col = Col1;
        }
    } else {
        /* Element1 does not exist. */
        ElementRightOfCol1 = pElement;

        /* Find Element2. */
        if (ElementRightOfCol1->Col != Col2) {
            do {
                ElementLeftOfCol2 = &(pElement->NextInRow);
                pElement = *ElementLeftOfCol2;
            }   while (pElement->Col < Col2);

            ElementRightOfCol2 = Element2->NextInRow;

            /* Move Element2 to Col1. */
            *ElementLeftOfCol2 = Element2->NextInRow;
            *ElementLeftOfCol1 = Element2;
            Element2->NextInRow = ElementRightOfCol1;
        }
        Element2->Col = Col1;
    }
    return;
}
```

Same doubly-linked caveat as `ExchangeColElements`.

### 4.13 CountMarkowitz (spfactor.c:783-826)

```c
static void
CountMarkowitz(MatrixPtr Matrix,  RealVector  RHS, int Step)
{
    int  Count, I, Size = Matrix->Size;
    ElementPtr  pElement;
    int  ExtRow;

    /* Begin `CountMarkowitz'. */

    /* Generate MarkowitzRow Count for each row. */
    for (I = Step; I <= Size; I++) {
        /* Set Count to -1 initially to remove count due to pivot element. */
        Count = -1;
        pElement = Matrix->FirstInRow[I];
        while (pElement != NULL && pElement->Col < Step)
            pElement = pElement->NextInRow;
        while (pElement != NULL) {
            Count++;
            pElement = pElement->NextInRow;
        }

        /* Include nonzero elements in the RHS vector. */
        ExtRow = Matrix->IntToExtRowMap[I];

        if (RHS != NULL)
            if (RHS[ExtRow] != 0.0)
                Count++;
        Matrix->MarkowitzRow[I] = Count;
    }

    /* Generate the MarkowitzCol count for each column. */
    for (I = Step; I <= Size; I++) {
        /* Set Count to -1 initially to remove count due to pivot element. */
        Count = -1;
        pElement = Matrix->FirstInCol[I];
        while (pElement != NULL && pElement->Row < Step)
            pElement = pElement->NextInCol;
        while (pElement != NULL) {
            Count++;
            pElement = pElement->NextInCol;
        }
        Matrix->MarkowitzCol[I] = Count;
    }
    return;
}
```

> The RHS-aware count (`if (RHS[ExtRow] != 0.0) Count++`) is a refinement used when the RHS is sparse. Our `factorWithReorder` is invoked WITHOUT a representative RHS (we factor without considering RHS sparsity). **Pass NULL.** That suppresses the RHS branch — `Count` remains the number of nonzero entries in the row excluding the diagonal-equivalent.

> `Count = -1` initial intentionally undercounts by one to remove the pivot element from the count. Our existing `finalize()` does `mRow[i] = rc > 0 ? rc - 1 : 0` — same idea but with a positive guard. **Replace with the `Count = -1, ++` pattern verbatim.** The `> 0 ? ... : 0` is wrong if `rc == 0` (means `mRow[i] = 0` even though the row has zero entries, but ngspice would set it to `-1`). ngspice does NOT special-case the empty-row case; an empty row gives `MarkowitzRow[I] = -1`. **The port keeps -1 for empty rows.** This matters because `MarkowitzProd` of an empty row × any column = -col_count, which is nonzero, so the row will not register as a singleton — the row IS singular and should be caught by the `MatrixIsSingular` path, not the singleton path.

> Actually verify: ngspice CountMarkowitz on an empty row: enters first `while (pElement != NULL && ...)` with `pElement = NULL`, exits immediately. Second `while (pElement != NULL)` skipped. Count remains -1. RHS branch may bump it to 0. Then `MarkowitzRow[I] = -1` or `0`. This is unusual — port it literally and let the search routines deal with the negative value as ngspice does (Markowitz product of `-1 * positive = negative`, would not register as zero, would not be selected as singleton). The reduced-column-singular case is caught by SearchEntireMatrix → spSINGULAR.

### 4.14 MarkowitzProducts (spfactor.c:866-896)

```c
static void
MarkowitzProducts(MatrixPtr Matrix, int Step)
{
    int  I, *pMarkowitzRow, *pMarkowitzCol;
    long  Product, *pMarkowitzProduct;
    int  Size = Matrix->Size;
    double fProduct;

    /* Begin `MarkowitzProducts'. */
    Matrix->Singletons = 0;

    pMarkowitzProduct = &(Matrix->MarkowitzProd[Step]);
    pMarkowitzRow = &(Matrix->MarkowitzRow[Step]);
    pMarkowitzCol = &(Matrix->MarkowitzCol[Step]);

    for (I = Step; I <= Size; I++) {
        /* If chance of overflow, use real numbers. */
        if ((*pMarkowitzRow > LARGEST_SHORT_INTEGER && *pMarkowitzCol != 0) ||
                (*pMarkowitzCol > LARGEST_SHORT_INTEGER && *pMarkowitzRow != 0)) {
            fProduct = (double)(*pMarkowitzRow++) * (double)(*pMarkowitzCol++);
            if (fProduct >= LARGEST_LONG_INTEGER)
                *pMarkowitzProduct++ = LARGEST_LONG_INTEGER;
            else
                *pMarkowitzProduct++ = (long)fProduct;
        } else {
            Product = *pMarkowitzRow++ * *pMarkowitzCol++;
            if ((*pMarkowitzProduct++ = Product) == 0)
                Matrix->Singletons++;
        }
    }
    return;
}
```

`LARGEST_SHORT_INTEGER` = 32767, `LARGEST_LONG_INTEGER` = 2^31-1 in ngspice (32-bit `long`). Our matrices are tiny (n < 1000); the overflow branch is dead code in practice. **Port the overflow branch anyway** — line-for-line.

### 4.15 UpdateMarkowitzNumbers (spfactor.c:2713-2760)

```c
static void
UpdateMarkowitzNumbers( MatrixPtr Matrix, ElementPtr pPivot )
{
    int  Row, Col;
    ElementPtr  ColPtr, RowPtr;
    int *MarkoRow = Matrix->MarkowitzRow;
    int *MarkoCol = Matrix->MarkowitzCol;
    double Product;

    /* Begin `UpdateMarkowitzNumbers'. */

    /* Update Markowitz numbers. */
    for (ColPtr = pPivot->NextInCol; ColPtr != NULL; ColPtr = ColPtr->NextInCol) {
        Row = ColPtr->Row;
        --MarkoRow[Row];

        /* Form Markowitz product while being cautious of overflows. */
        if ((MarkoRow[Row] > LARGEST_SHORT_INTEGER && MarkoCol[Row] != 0) ||
                (MarkoCol[Row] > LARGEST_SHORT_INTEGER && MarkoRow[Row] != 0)) {
            Product = MarkoCol[Row] * MarkoRow[Row];
            if (Product >= LARGEST_LONG_INTEGER)
                Matrix->MarkowitzProd[Row] = LARGEST_LONG_INTEGER;
            else
                Matrix->MarkowitzProd[Row] = (long)Product;
        } else Matrix->MarkowitzProd[Row] = MarkoRow[Row] * MarkoCol[Row];
        if (MarkoRow[Row] == 0)
            Matrix->Singletons++;
    }

    for (RowPtr = pPivot->NextInRow;
            RowPtr != NULL;
            RowPtr = RowPtr->NextInRow) {
        Col = RowPtr->Col;
        --MarkoCol[Col];

        /* Form Markowitz product while being cautious of overflows. */
        if ((MarkoRow[Col] > LARGEST_SHORT_INTEGER && MarkoCol[Col] != 0) ||
                (MarkoCol[Col] > LARGEST_SHORT_INTEGER && MarkoRow[Col] != 0)) {
            Product = MarkoCol[Col] * MarkoRow[Col];
            if (Product >= LARGEST_LONG_INTEGER)
                Matrix->MarkowitzProd[Col] = LARGEST_LONG_INTEGER;
            else
                Matrix->MarkowitzProd[Col] = (long)Product;
        } else Matrix->MarkowitzProd[Col] = MarkoRow[Col] * MarkoCol[Col];
        if ((MarkoCol[Col] == 0) && (MarkoRow[Col] != 0))
            Matrix->Singletons++;
    }
    return;
}
```

> Called AFTER `RealRowColElimination` writes any new fill-ins. In the ngspice flow, fill-ins added during elimination already affect the linked structure that this routine walks. **In our flow:** `_numericLUMarkowitz` adds fill-ins inside its column-k loop. The Markowitz update runs after our existing fill-in insertion — the same ordering. Replace our `_updateMarkowitzNumbers` body with a port of the above, walking the just-eliminated pivot's row and column chains.

### 4.16 spOrderAndFactor outer loop (spfactor.c:200-284 — relevant excerpt)

```c
    /* Form initial Markowitz products. */
    CountMarkowitz( Matrix, RHS, Step );
    MarkowitzProducts( Matrix, Step );
    Matrix->MaxRowCountInLowerTri = -1;

    /* Perform reordering and factorization. */
    for (; Step <= Size; Step++) {
        pPivot = SearchForPivot( Matrix, Step, DiagPivoting );
        if (pPivot == NULL) return MatrixIsSingular( Matrix, Step );
        ExchangeRowsAndCols( Matrix, pPivot, Step );

        if (Matrix->Complex)
            ComplexRowColElimination( Matrix, pPivot );
        else
            RealRowColElimination( Matrix, pPivot );

        if (Matrix->Error >= spFATAL) return Matrix->Error;
        UpdateMarkowitzNumbers( Matrix, pPivot );
    }
```

This is the outer-loop skeleton. Our `_numericLUMarkowitz` already implements the Step-loop with our own elimination body. The required structural change is:

1. Before the loop: `_countMarkowitz()` then `_markowitzProducts()` (replace `finalize()`'s in-line counting + product code).
2. Inside the loop: replace the current `_searchForPivot → if col != k swap and re-scatter` block with `pPivot = _searchForPivot(step) → if NULL return singular → _exchangeRowsAndCols(pPivot, step)`.
3. After elimination commit: `_updateMarkowitzNumbers(pPivot)`.

Note that ngspice's `RealRowColElimination` walks the linked structure and writes back; our Gilbert-Peierls runs the dense-scatter L-solve. The two are mathematically equivalent for the same pivot choice. We retain our elimination body; we just replace the pivot-selection and bookkeeping that wraps it.

---

## 5. Our code touchpoints

### 5.1 New fields in `SparseSolver` (insert near sparse-solver.ts:120-200)

```ts
  /**
   * Slot → original-row map. _intToExtRow[slot] = original row index.
   * Identity at factor entry; updated by spcRowExchange when rows physical-swap.
   * Mirrors ngspice IntToExtRowMap.
   */
  private _intToExtRow: Int32Array = new Int32Array(0);

  /**
   * Original-row → slot map. _extToIntRow[origRow] = slot index.
   * Identity at factor entry; updated by spcRowExchange in lockstep with
   * _intToExtRow. Mirrors ngspice ExtToIntRowMap.
   */
  private _extToIntRow: Int32Array = new Int32Array(0);
```

Allocate in `_initStructure` (sparse-solver.ts:852-923) — see 5.7.

### 5.2 `_markowitzRow`, `_markowitzCol`, `_markowitzProd` allocation

Currently sparse-solver.ts:298-301:
```ts
  private _markowitzRow: Int32Array = new Int32Array(0);
  private _markowitzCol: Int32Array = new Int32Array(0);
  private _markowitzProd: Float64Array = new Float64Array(0);
  private _singletons: number = 0;
```

ngspice uses sentinel slots `MarkowitzProd[Step-1]` and `MarkowitzProd[Size+1]`. The lowest accessed index is `Step - 1` (when Step==1 in ngspice → 0 here when step==1; when step==0 the sentinel write is `_markowitzProd[-1]`, out of bounds).

**Resolution:** allocate `_markowitzProd` with two extra trailing slots (length n + 2). The "step - 1" sentinel write at step == 0 is skipped via guard (ngspice's `Step >= 1` always means we write to index 0 or higher; in our 0-based world the analog is step==0 → no underflow guard needed because the inner-while of SearchForSingleton terminates at `I < step`). Confirm during port: at step==0, the `mProd[step - 1] = 0` write becomes `mProd[-1]` — **don't write it**; the `MarkowitzProd[Size+1]` dual-purpose slot at `mProd[n]` and the trailing `mProd[n+1]` (used by `QuicklySearchDiagonal`'s `pMarkowitzProduct = &MarkowitzProd[Size+2]` start) ARE used.

Make `_markowitzRow`, `_markowitzCol`, `_markowitzProd` length `n + 2`. Update finalize / count / products to write only [0, n).

Convert `_markowitzProd` from `Float64Array` to `Float64Array` of integer-valued products **OR** `Int32Array`. ngspice uses `long`. Since LARGEST_LONG_INTEGER fits in 31 bits and our matrices are small, `Int32Array` is correct and matches ngspice semantics (the overflow branch promotes to double then truncates back to long; on our matrices the values are small). **Use `Int32Array`** and mirror the overflow guard literally.

### 5.3 `finalize()` — replace with `_countMarkowitz` + `_markowitzProducts`

Current code (sparse-solver.ts:460-487):
```ts
  finalize(): void {
    const n = this._n;
    const mRow = this._markowitzRow;
    const mCol = this._markowitzCol;
    const mProd = this._markowitzProd;
    let singletons = 0;

    for (let i = 0; i < n; i++) {
      let rc = 0;
      let e = this._rowHead[i];
      while (e >= 0) {
        if (!(this._elFlags[e] & FLAG_FILL_IN)) rc++;
        e = this._elNextInRow[e];
      }
      mRow[i] = rc > 0 ? rc - 1 : 0;

      let cc = 0;
      e = this._colHead[i];
      while (e >= 0) {
        if (!(this._elFlags[e] & FLAG_FILL_IN)) cc++;
        e = this._elNextInCol[e];
      }
      mCol[i] = cc > 0 ? cc - 1 : 0;

      mProd[i] = mRow[i] * mCol[i];
      if (mProd[i] === 0) singletons++;
    }
    this._singletons = singletons;
    ...
  }
```

> The `> 0 ? rc - 1 : 0` guard, `FLAG_FILL_IN` filtering, and the in-line product compute are all wrong vs ngspice. Reasons: ngspice does NOT skip fill-ins (in CountMarkowitz called from spOrderAndFactor, no fill-ins exist yet because elimination hasn't started); ngspice initialises Count=-1 (no max guard); ngspice computes products in a separate pass `MarkowitzProducts`.

**Replacement:**
- `finalize()` still computes pre-solve RHS capture, but defers all Markowitz work to factor entry.
- Call `_countMarkowitz(step=0)` and `_markowitzProducts(step=0)` from inside `_numericLUMarkowitz` (sparse-solver.ts:1185-ish, before the for-step loop) — that's where ngspice does it (spOrderAndFactor:255-256). NOT from `finalize()`.

Add private methods `_countMarkowitz(step: number)` and `_markowitzProducts(step: number)` matching §4.13 and §4.14 line-for-line. Iterate I from `step` to `n - 1`; access `_rowHead[I]` and `_colHead[I]` (post-port, these are slot-indexed); skip elements with `_elCol[e] < step` (resp. `_elRow[e] < step`) by walking `_elNextInRow[e]` (resp. `_elNextInCol[e]`).

### 5.4 `_findLargestInColBelow` — DELETE; replaced by `_findLargestInCol`

Current code (sparse-solver.ts:1756-1765):
```ts
  private _findLargestInColBelow(startE: number): number {
    let largest = 0;
    let e = startE;
    while (e >= 0) {
      const mag = Math.abs(this._elVal[e]);
      if (mag > largest) largest = mag;
      e = this._elNextInCol[e];
    }
    return largest;
  }
```

Replace with line-for-line port of `FindLargestInCol` (§4.6):

```ts
  /**
   * Direct port of ngspice FindLargestInCol (spfactor.c:1849-1863).
   * Walks the column chain starting at startE, returning the largest |val|.
   */
  private _findLargestInCol(startE: number): number {
    let largest = 0;
    let e = startE;
    while (e >= 0) {
      const magnitude = Math.abs(this._elVal[e]);
      if (magnitude > largest) largest = magnitude;
      e = this._elNextInCol[e];
    }
    return largest;
  }
```

The body is byte-for-byte identical to the existing helper; the rename clarifies the ngspice mapping. Update the one caller in `_numericLUReusePivots` (sparse-solver.ts:1547) to use the new name.

### 5.5 Add `_findBiggestInColExclude`

Insert near §5.4 after `_findLargestInCol`:

```ts
  /**
   * Direct port of ngspice FindBiggestInColExclude (spfactor.c:1913-1944).
   * Returns the largest |val| in the active part of the column containing
   * pElement, EXCLUDING pElement itself. Step is the current pivot step.
   */
  private _findBiggestInColExclude(pE: number, step: number): number {
    const row = this._elRow[pE];
    const col = this._elCol[pE];
    let e = this._colHead[col];

    /* Travel down column until reduced submatrix is entered. */
    while (e >= 0 && this._elRow[e] < step) {
      e = this._elNextInCol[e];
    }

    /* Initialize the variable Largest. */
    let largest: number;
    if (e >= 0 && this._elRow[e] !== row) {
      largest = Math.abs(this._elVal[e]);
    } else {
      largest = 0.0;
    }

    /* Search rest of column for largest element, avoiding excluded element. */
    while (e >= 0) {
      e = this._elNextInCol[e];
      if (e < 0) break;
      const mag = Math.abs(this._elVal[e]);
      if (mag > largest && this._elRow[e] !== row) {
        largest = mag;
      }
    }

    return largest;
  }
```

> The control-flow shape mirrors ngspice's `while ((pElement = pElement->NextInCol) != NULL) { if (Magnitude > Largest) { if (pElement->Row != Row) Largest = Magnitude; } }` — the "row != excluded row" guard sits **inside** the magnitude-larger guard, so an excluded-row element with magnitude == Largest does not zero anything. Preserve that ordering.

### 5.6 `_searchForPivot` — DELETE current body, replace with dispatch + four routines

Current code (sparse-solver.ts:1767-1940). DELETE entirely. Replace with:

```ts
  /**
   * Pivot search dispatch. Direct port of ngspice SearchForPivot
   * (spfactor.c:947-994). Returns pool element handle of chosen pivot, or
   * -1 if no acceptable pivot exists (matrix is singular).
   *
   * Step is the current 0-based diagonal step (== ngspice Step - 1 conceptually,
   * but our arrays are 0-based so 'step' here = ngspice 'Step' as written).
   */
  private _searchForPivot(step: number): number {
    let chosen: number;

    if (this._singletons > 0) {
      chosen = this._searchForSingleton(step);
      if (chosen >= 0) return chosen;
    }

    chosen = this._quicklySearchDiagonal(step);
    if (chosen >= 0) return chosen;

    chosen = this._searchDiagonal(step);
    if (chosen >= 0) return chosen;

    return this._searchEntireMatrix(step);
  }
```

Then add `_searchForSingleton`, `_quicklySearchDiagonal`, `_searchDiagonal`, `_searchEntireMatrix` as direct ports of §4.2-4.5. Use `MAX_MARKOWITZ_TIES = 100`, `TIES_MULTIPLIER = 5`, `LARGEST_LONG_INTEGER = 0x7fffffff`.

> Returns: in ngspice the return is `ElementPtr`. Here it is the pool element handle (`number`, -1 for NULL). The caller then reads `_elRow[chosen]` and `_elCol[chosen]` to drive `_exchangeRowsAndCols`.

### 5.7 `_exchangeRowsAndCols` — replaces `_swapColumnsForPivot`

Current `_swapColumnsForPivot` (sparse-solver.ts:729-747) is structurally insufficient — it doesn't update `_elCol[e]` for elements in the swapped columns and doesn't re-thread row chains. Delete it. Replace with `_exchangeRowsAndCols(pivotE, step)` matching §4.8:

```ts
  /**
   * Direct port of ngspice ExchangeRowsAndCols (spfactor.c:1986-2070).
   * Moves the chosen pivot to physical slot (step, step) by physical-
   * swapping rows and columns via _spcRowExchange / _spcColExchange.
   * Updates Diag[], MarkowitzProd[], and Singletons count.
   */
  private _exchangeRowsAndCols(pivotE: number, step: number): void { /* ... */ }

  private _spcRowExchange(row1: number, row2: number): void { /* port of §4.9 */ }
  private _spcColExchange(col1: number, col2: number): void { /* port of §4.10 */ }
  private _exchangeColElements(
    row1: number, e1: number, row2: number, e2: number, column: number,
  ): void { /* port of §4.11 — doubly-linked */ }
  private _exchangeRowElements(
    col1: number, e1: number, col2: number, e2: number, row: number,
  ): void { /* port of §4.12 — doubly-linked */ }
```

Use the helper sketched in §4.11's note for doubly-linked splice consistency.

After `_exchangeRowsAndCols` returns:
- `_elRow[pivotE] === step` and `_elCol[pivotE] === step`.
- `_diag[step] === pivotE`.
- `_markowitzRow`, `_markowitzCol`, `_markowitzProd`, `_singletons` updated per §4.8.
- `_intToExtRow[step]` holds the original row that was selected.
- `_q[step] = _intToExtRow[step]; _pinv[_intToExtRow[step]] = step` so `solve()` keeps working without change.

### 5.8 `_updateMarkowitzNumbers` — replace body

Current code (sparse-solver.ts:1949-1981). Replace with line-for-line port of §4.15. Walks `_elNextInCol[pivotE]` then `_elNextInRow[pivotE]`. The pivot element handle is passed in (the agent must thread it through from the new outer loop in 5.9).

### 5.9 `_numericLUMarkowitz` — outer loop changes

Current code (sparse-solver.ts:1180-1448). Edit only the per-step pivot section:

**Before the for-step loop**, after the structure setup but before `for (let k = 0; k < n; k++)`:

```ts
    // Initial Markowitz counts and products — ngspice spOrderAndFactor:254-256.
    this._countMarkowitz(/* step= */ 0);
    this._markowitzProducts(/* step= */ 0);
```

**Inside the loop**, replace the existing block at sparse-solver.ts:1280-1356 (the `_searchForPivot → if pivotResult.col !== k swap and re-scatter` block):

```ts
      // Pivot search — ngspice spOrderAndFactor:261.
      const pivotE = this._searchForPivot(k);
      if (pivotE < 0) {
        for (let idx = 0; idx < xNzCount; idx++) x[xNzIdx[idx]] = 0;
        return { success: false, singularRow: k };
      }

      // Bring the pivot to slot (k, k) via physical row/col swap.
      // ngspice spOrderAndFactor:263 ExchangeRowsAndCols.
      this._exchangeRowsAndCols(pivotE, k);

      // After the swap, the chosen pivot sits at (_elRow=k, _elCol=k) and
      // _colHead[k] points at the chain that used to be in pivotResult.col.
      // We need to clear x[], re-scatter the new column k, and re-run the
      // triangular solve. (Equivalent to our existing post-swap re-scatter
      // block but unconditional: ExchangeRowsAndCols moves both rows and
      // columns, so x[] is invalidated even if Col was already step.)
      for (let idx = 0; idx < xNzCount; idx++) x[xNzIdx[idx]] = 0;
      xNzCount = 0;
      this._elMark.fill(-1);

      // ... existing re-scatter + triangular solve + fill-in insertion code
      // from sparse-solver.ts:1302-1355 reused as-is, with one important
      // edit: the column variable that selects the original column for
      // newly created fill-ins is now _preorderColPerm[k] which after the
      // swap points to whichever original column ended up at slot k.
```

**After the elimination commit** (sparse-solver.ts:1431-ish, after `for (let idx = 0; idx < xNzCount; idx++) x[xNzIdx[idx]] = 0;`), insert:

```ts
      // ngspice spOrderAndFactor:271.
      this._updateMarkowitzNumbers(pivotE);
```

> The current body's special-case `if (pivotResult.col !== k)` branch went away because `_exchangeRowsAndCols` always normalises to slot `(k,k)` even when `pPivot->Row == step && pPivot->Col == step` (it returns early in that case, but the post-swap state is already correct). The "always re-scatter" block above is unconditional — incurring at most one extra scatter when the pivot is already on the diagonal at slot (k,k). That's acceptable; ngspice does the same (the elimination body always runs from `FirstInCol[Step]`).

### 5.10 `solve()` — verify no change required

Current code (sparse-solver.ts:547-588). After the port:
- `_q[k]` is the original row chosen as pivot at step k → equals `_intToExtRow[k]`. So `b[k] = rhs[q[k]]` keeps working.
- `_pinv[origRow]` is the step at which origRow was picked → equals `_extToIntRow[origRow]`. The `pinv[_lRowIdx[p]]` and `pinv[_uRowIdx[p]]` lookups inside the L/U passes still translate "original row of stored fill-in" → "step where that row got pivoted".

> **Wait.** Post-port, `_lRowIdx[p]` stores **what** — original row or slot? After `_exchangeRowsAndCols` physically moves rows in the linked structure, every fill-in that was created has `_elRow[e] = slotIndex` at creation time (because the row is at slot `slotIndex` when fill-in is committed). The L/U write code at sparse-solver.ts:1382-1429 stores `_uRowIdx[unz] = i` where `i` came from `_xNzIdx[]`. `i` is the **slot index** of the row in the dense scatter (the dense scatter is keyed by slot post-port).
>
> So `_lRowIdx` / `_uRowIdx` end up storing **slot indices**. For `solve()` to translate slot back to original-row when consuming the RHS / writing the solution: `b[step] = rhs[intToExtRow[step]]` and `x[origCol] = b[step] /* via _preorderColPerm[step] */`.
>
> **Impact on solve():** `b[k] = rhs[q[k]]` continues to work IFF `q[k] === _intToExtRow[k]` — set them in lockstep at every `_exchangeRowsAndCols` call.
>
> The L/U back-sub: `b[pinv[_lRowIdx[p]]] -= ...` — `_lRowIdx[p]` is now a slot index, so `pinv[slot]` translates "original row → step" but here we'd be feeding it a slot. **This is wrong.** Replace with: `_lRowIdx[p]` IS the slot, and the slot IS the step (post-port: `q[step] = origRow` so `pinv[origRow] = step`, but `_lRowIdx` doesn't index by origRow). Fix: in `solve()`, change `b[pinv[_lRowIdx[p]]]` → `b[_lRowIdx[p]]` (slot-direct).

**`solve()` post-port body:**

```ts
  solve(x: Float64Array): void {
    const n = this._n;
    if (n === 0) return;

    const intToExt = this._intToExtRow;
    const b = this._scratch;

    // Step 1: Apply pivot row permutation to RHS.
    for (let k = 0; k < n; k++) b[k] = this._rhs[intToExt[k]];

    // Step 2: Forward sub on L (lRowIdx is slot-indexed post-port).
    for (let j = 0; j < n; j++) {
      const p0 = this._lColPtr[j];
      const p1 = this._lColPtr[j + 1];
      const bj = b[j];
      for (let p = p0; p < p1; p++) {
        b[this._lRowIdx[p]] -= this._lVals[p] * bj;
      }
    }

    // Step 3: Backward sub on U.
    for (let j = n - 1; j >= 0; j--) {
      const p0 = this._uColPtr[j];
      const p1 = this._uColPtr[j + 1];
      b[j] *= this._uDiagInv[j];
      const bj = b[j];
      for (let p = p0; p < p1 - 1; p++) {
        b[this._uRowIdx[p]] -= this._uVals[p] * bj;
      }
    }

    // Step 4: Apply column inverse permutation.
    const pcp = this._preorderColPerm;
    for (let k = 0; k < n; k++) x[pcp[k]] = b[k];
  }
```

Sanity check during port: confirm `_lRowIdx[p]` is written as the slot index in `_numericLUMarkowitz` (lines 1382-1429 use `i` from `_xNzIdx[]`, which is slot-indexed because the dense scatter is keyed by slot — verify this is true post-port by checking that the column-k scatter at sparse-solver.ts:1219-1233 reads `_elRow[ae]` which is now slot-indexed).

`_numericLUReusePivots` (sparse-solver.ts:1457) needs the same `_lRowIdx`/slot-direct treatment in any place it consumes `_pinv[_lRowIdx[p]]` — check carefully and adjust.

### 5.11 `_initStructure` allocation

Current code (sparse-solver.ts:852-923). Add at the end:
```ts
    this._intToExtRow = new Int32Array(n);
    this._extToIntRow = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      this._intToExtRow[i] = i;
      this._extToIntRow[i] = i;
    }
```

Bump `_markowitzRow`, `_markowitzCol`, `_markowitzProd` to length `n + 2`:
```ts
    this._markowitzRow = new Int32Array(n + 2);
    this._markowitzCol = new Int32Array(n + 2);
    this._markowitzProd = new Int32Array(n + 2);  // type changed Float64 → Int32
```

In `beginAssembly` at sparse-solver.ts:444-454, mirror the length-`n+2` guard:
```ts
    if (this._markowitzRow.length !== size + 2) {
      this._markowitzRow = new Int32Array(size + 2);
      this._markowitzCol = new Int32Array(size + 2);
      this._markowitzProd = new Int32Array(size + 2);
    } else {
      this._markowitzRow.fill(0);
      this._markowitzCol.fill(0);
      this._markowitzProd.fill(0);
    }
```

`_intToExtRow` / `_extToIntRow` reset to identity at `beginAssembly`:
```ts
    if (this._intToExtRow.length !== size) {
      this._intToExtRow = new Int32Array(size);
      this._extToIntRow = new Int32Array(size);
    }
    for (let i = 0; i < size; i++) {
      this._intToExtRow[i] = i;
      this._extToIntRow[i] = i;
    }
```

`_preorderColPerm` / `_extToIntCol` are already reset in `_initStructure` and persisted across assemblies — preserve current behaviour.

### 5.12 `_findDiagOnColumn` — adjust for new diagonal invariant

Current code (sparse-solver.ts:757-765):
```ts
  private _findDiagOnColumn(internalCol: number): number {
    const diagRow = this._preorderColPerm[internalCol];
    let e = this._colHead[internalCol];
    while (e >= 0) {
      if (this._elRow[e] === diagRow) return e;
      e = this._elNextInCol[e];
    }
    return -1;
  }
```

Post-port, after row physical swap, the diagonal of slot `internalCol` is the element where `_elRow[e] === internalCol` (the slot row equals the slot col on the diagonal). Replace:
```ts
  private _findDiagOnColumn(slot: number): number {
    let e = this._colHead[slot];
    while (e >= 0) {
      if (this._elRow[e] === slot) return e;
      e = this._elNextInCol[e];
    }
    return -1;
  }
```

This matches ngspice `spcFindElementInCol(... Col, Col, ...)` used in §4.8.

### 5.13 `allocElement` — `_elCol` semantics

Current code (sparse-solver.ts:331-394). `_elCol[e]` currently stores the original column. Post-port, after `spcColExchange`, `_elCol[e]` must be updated to the slot the element's column now occupies. The `allocElement` fast path translates the caller's original column to internal column via `_extToIntCol[col]` — keep that.

> **Critical:** `allocElement` is called from element factories at compile time, BEFORE any factor pass runs. So `_elCol[e]` is initialised to the original column. The first `factor()` runs `_exchangeRowsAndCols` which calls `_spcColExchange` which writes `_elCol[e] = newSlot` for every element in the swapped columns. After the first factor, `_elCol[e]` is slot-indexed.
>
> But `beginAssembly` resets fill-ins (sparse-solver.ts:933-961) — the surviving A-entries retain their slot-indexed `_elCol[e]` from the prior factor. When stamping in the next NR iteration, the stamper looks up handles via the handle table (`_handleTable[row * _handleTableN + col]`), which is keyed by **original** (row, col). It just reads the handle and additively stamps `_elVal[e] += value`. So the slot-indexed `_elCol[e]` does not affect stamping.
>
> However, when `factor()` runs again with `_needsReorder = false`, `_numericLUReusePivots` runs in the existing slot order — fine. When `_needsReorder = true`, `_numericLUMarkowitz` runs from the slot-indexed state. The first thing it does is `_countMarkowitz(0) / _markowitzProducts(0)` which walks `_rowHead[I]` for I ∈ [0, n). Those chains were last updated by the prior factor's row swaps, so the indexing is consistent.
>
> **The hazard** is when `_needsReorder` is forced true mid-pass (e.g. via `forceReorder()` from niiter.c:858 NISHOULDREORDER). At that point we need to:
> 1. Restore `_intToExtRow` / `_extToIntRow` to identity? **No.** ngspice doesn't — it carries the residual permutation forward.
> 2. Rerun `CountMarkowitz / MarkowitzProducts` in the current slot order. **Yes** — that's what spOrderAndFactor:255-256 does.
>
> Conclusion: **No special handling for `forceReorder`.** The existing slot state continues; the new pivot pass picks fresh pivots starting from the current state.

### 5.14 `factorWithReorder` — call site

Current code (sparse-solver.ts:1674-1696). No change required — `_numericLUMarkowitz` is the body that's being modified.

---

## 6. Implementation order

Each step must compile clean and leave the test suite in a known state (passing OR red with documented expected failures) before the next step begins. Commit after every step.

1. **Field & allocation scaffolding.** Add `_intToExtRow`, `_extToIntRow`. Bump `_markowitzRow/_markowitzCol/_markowitzProd` to length `n + 2`. Type-change `_markowitzProd` Float64 → Int32. Reset to identity in `beginAssembly`. Build clean.
2. **Port `_findLargestInCol`** (rename from `_findLargestInColBelow`) and **add `_findBiggestInColExclude`**. Rewire the one existing caller in `_numericLUReusePivots`. Build clean.
3. **Port `_countMarkowitz` and `_markowitzProducts`** as private methods. Replace `finalize()`'s in-line counting with calls to these inside `_numericLUMarkowitz` (before the for-step loop). Build clean. At this point the existing `_searchForPivot` is still the broken one — pivots still pick wrong, tests still red.
4. **Port `_searchForSingleton`, `_quicklySearchDiagonal`, `_searchDiagonal`, `_searchEntireMatrix`** as direct line-for-line ports. Replace `_searchForPivot` body with the dispatch. **Don't yet wire the new `_exchangeRowsAndCols`** — keep the current `_swapColumnsForPivot` for one commit so the new search returns a slot pair the old swap can consume on a best-effort basis (the row half won't move, so tests will still be red but cleanly red — pivot CHOICE is now ngspice-correct, but the row stays where it is).
5. **Port `_spcRowExchange`, `_spcColExchange`, `_exchangeRowElements`, `_exchangeColElements`, `_exchangeRowsAndCols`.** Wire `_numericLUMarkowitz` to call `_exchangeRowsAndCols` post-search. Update `_q` / `_pinv` from inside `_exchangeRowsAndCols` so `solve()` keeps working. Update `_findDiagOnColumn`. Delete `_swapColumnsForPivot`.
6. **Port `_updateMarkowitzNumbers`** matching §4.15. Replace existing body. Wire from outer loop.
7. **Update `solve()` and `_numericLUReusePivots`** for slot-indexed `_lRowIdx` / `_uRowIdx` (drop `pinv[]` from the inner-loop indexing — it becomes identity at this layer; keep `_q[k]` for `b[k] = rhs[q[k]]` since `q[]` stores original row).
8. **Run** the parity test fleet. Investigate any failures; expected to be zero on the four tests of interest (10.1-10.4) and on the broader fleet. Any failing test is a port bug, not a "tolerance" issue — fix the port.

---

## 7. Verification

- Build: `npx tsc --noEmit 2>&1 | head -50` — zero errors.
- Parity (focused): `npx vitest run src/solver/analog/__tests__/ngspice-parity/ --reporter=basic 2>&1 | tail -200`
- Full unit: `npm run test:q`
- Manual sanity: pull a 2×2 matrix with two singletons (e.g. the user's BJT step-1 case: col-0 singleton at row 3, col-3 singleton at row 0), run pivot search, confirm slot 3 gets selected first (matching ngspice's end-to-start scan order).

---

## 8. Notes for the implementing agent

- **Do not** "simplify" any of the ngspice routines. The endless-`for` loops, the `Singletons--; ... Singletons++` speculation pattern, the `MarkowitzProd[Step-1] = 0/-1` sentinels, the dual-purpose `MarkowitzProd[Size+1] = MarkowitzProd[Step]` slot, the early `return ChosenPivot` from inside `MAX_MARKOWITZ_TIES`-bounded loops, the `LargestElementMag` / `pLargestElement` spSMALL_PIVOT fallback, the `RatioOfAccepted` initialisation to 0 then comparison `Ratio < RatioOfAccepted` (which selects strictly smaller, so the first tie always wins) — all stay.
- **Do not** wander outside this spec. No "while we're here" simplifications, no test cleanup, no comment polish elsewhere in the file.
- **Do** add brief ngspice citations on each ported routine: `// ngspice spfactor.c:1041-1172 SearchForSingleton — line-for-line port.`
- **Do** preserve our existing pool/handle/free-list invariants. The doubly-linked splice helpers must keep `_elPrevInCol[head] === -1` for the list head.
- **Do** confirm post-port that `_extToIntRow[_intToExtRow[I]] === I` and `_intToExtRow[_extToIntRow[r]] === r` — add a debug assertion at end of `_exchangeRowsAndCols` that's compiled out in release.
- If something looks impossible, escalate per `CLAUDE.md` "Escalation Protocol". Do not invent a workaround.
