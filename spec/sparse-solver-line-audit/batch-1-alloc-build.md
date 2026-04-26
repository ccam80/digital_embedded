# Sparse Solver Line Audit — Batch 1: Allocation & Build

**TS file:** `src/solver/analog/sparse-solver.ts`
**TS line ranges audited:** 1–505 and 1068–1338
**ngspice references:** `ref/ngspice/src/maths/sparse/spalloc.c`, `spbuild.c`, `spdefs.h`

---

## 1. Header summary

Counted lines = lines that contain TypeScript source after stripping blank lines, lines containing only `{`/`}`/`*/`/`/**`, JSDoc comments, and `//` comment lines. Class-field declarations and `private/public` modifiers are counted as source.

| Metric | Value |
|---|---|
| Total non-comment, non-blank TS source lines in audited ranges | 198 |
| `match` lines | 84 |
| `diff` lines | 114 |
| TS function/class definitions in range | 14 |
| `match` function/class definitions | 1 |
| `diff` function/class definitions | 13 |

Note: per the spec the bar for `match` is 1:1 correspondence with a single ngspice function with the same arguments and return semantics. Most TS methods in this batch fold portions of multiple ngspice routines together (e.g. `_initStructure` covers `spCreate` + portions of `spcCreateInternalVectors` + portions of `InitializeElementBlocks`), so they are `diff`.

---

## 2. Per-function definition table

| TS line | TS signature | ngspice function (file:line) | Class | Notes |
|---|---|---|---|---|
| 122 | `export class SparseSolver` | `struct MatrixFrame` (spdefs.h:733-788) | diff | Class wraps state; not a ngspice function. Adds digiTS-only flags (`_structureEmpty`, `_workspaceN`, `_capturePreSolveRhs`, `_capturePreFactorMatrix`, `_didPreorder`). |
| 353 | `constructor()` | (no ngspice equivalent) | diff (digiTS-only) | C uses `spCreate(Size, Complex, *pError)` factory; TS has empty ctor and defers all init to `beginAssembly`. |
| 371 | `allocElement(row, col): number` | `spGetElement` (spbuild.c:264-318) | diff | Returns int handle vs. C `RealNumber*`. Skips C row==col / Diag fast path (spbuild.c:306). Skips `Row==0||Col==0 → TrashCan` short-circuit (spbuild.c:272). Skips `assert(Matrix->NeedsOrdering)` (spbuild.c:276). Adds digiTS-only `_n===0` guard. Performs `_extToIntCol[col]` translation that ngspice does only under `#if TRANSLATE`. |
| 399 | `_spcFindElementInCol(col, row, createIfMissing): number` | `spcFindElementInCol` (spbuild.c:362-393) | diff | Signature differs: ngspice takes `(Matrix, ElementPtr *LastAddr, Row, Col, CreateIfMissing)` — five args including a pointer-to-pointer for the splice address; TS takes three args and recomputes `prev` from local walk, then passes `prev` index to `_spcCreateElement`. Returns int vs. ElementPtr. |
| 429 | `_spcCreateElement(row, col, prevInCol, fillin): number` | `spcCreateElement` (spbuild.c:767-872) | diff | Body is heavily restructured: C has two large branches (RowsLinked vs not) each with its own column splice and `Diag` set; TS has one column-splice block, hoists `Diag` set into `_newElement`, and gates only the row insert by `_rowsLinked`. C order: alloc → Diag → init fields → col splice → row splice. TS order: alloc (with Diag inside) → col splice → row splice → counter writes. Counter writes in TS happen after splice; in C they happen inside the alloc branch. |
| 467 | `stampElement(handle, value): void` | `*ElementPtr += value` macro (spdefs.h `spADD_REAL_ELEMENT`) | diff | This is a `+=` macro pattern in C, not a function. TS wraps it in a method call; C inlines it at every call site. |
| 474 | `stampRHS(row, value): void` | (no ngspice function) | diff (digiTS-only) | ngspice's RHS is the caller's `RealVector`; assembly is done by per-device loaders (e.g. `RHS[node] += val` in BJTload). No ngspice function corresponds. |
| 505 | `beginAssembly(size): void` | `spCreate` (spalloc.c:117-277) **+** `spClear` (spbuild.c:96-142) | diff | TS folds two distinct ngspice entry points behind a `_structureEmpty` flag. ngspice never dispatches between Create and Clear in one function — caller picks. |
| 1068 | `_initStructure(n): void` | `spCreate` (spalloc.c:117-277) **+** `spcCreateInternalVectors` (spfactor.c:706-747, not in this file) | diff | Single TS body fuses `spCreate` allocations, `InitializeElementBlocks` element-pool setup, and `spcCreateInternalVectors` (Markowitz arrays). Doubles as `RHS` allocator (ngspice has no RHS field on MatrixFrame). |
| 1144 | `_resetForAssembly(): void` | `spClear` (spbuild.c:96-142) | match | 1:1 — reverse column walk zeroing `pElement->Real` then setting Factored=NO, Singular*=0, Error=spOKAY. Only divergence is missing PreviousMatrixWasComplex update, which is not modelled in TS (real-only solver). Counted `match` because the body operations and order correspond directly. |
| 1177 | `_newElement(row, col, val, _flags): number` | `spcGetElement` (spalloc.c:310-364) **+** field init from `spcCreateElement` (spbuild.c:797-800/853-860) **+** `Diag[Row]=` (spbuild.c:793/851) | diff | C `spcGetElement` only returns the next pool slot. TS `_newElement` additionally writes Row/Col/Real and sets Diag. Three ngspice responsibilities fused in one TS function; `_flags` parameter is dead. |
| 1202 | `_insertIntoRow(e, row): void` | inline body inside `spcCreateElement` (spbuild.c:809-837) | diff | Extracted as standalone TS function; in ngspice this code only exists inline inside the `if (Matrix->RowsLinked)` branch of `spcCreateElement`. ngspice walks with `pLastElement` and a separate "set pElement=NULL" loop break (`else pElement = NULL`); TS uses standard `prev`/`cur` pattern with break-on-condition in the while predicate. |
| 1232 | `_createFillin(row, col): number` | `CreateFillin` (spfactor.c:2798-2829, not in this file) | diff (out of file) | Calls into `_spcCreateElement` with `fillin=true`; performs Markowitz/Singletons bookkeeping. ngspice `CreateFillin` is in spfactor.c, not spalloc.c/spbuild.c — strictly speaking out of this batch's reference scope, but listed here as a function in the audited TS range. |
| 1265 | `_insertIntoCol(e, col): void` | inline body of `spcCreateElement` (spbuild.c:805-807) plus the find-position walk in `spcFindElementInCol` (spbuild.c:372-386) | diff | Standalone TS helper that has no direct ngspice counterpart. ngspice `spcCreateElement` already receives `*LastAddr` from the caller (spbuild.c:806-807); the column-position walk is performed earlier in `spcFindElementInCol`. TS factors this out; the function is currently unused from `_spcCreateElement` (which receives prev from `_spcFindElementInCol`). |
| 1278 | `_growElements(): void` | `spcGetElement` block-allocation tail (spalloc.c:319-325) | diff (digiTS-only) | C uses fixed-size block allocation with a free-list (`ElementsRemaining`, `NextAvailElement`, `ELEMENTS_PER_ALLOCATION` blocks); TS uses doubling-array growth with `Int32Array.set`. Different allocator strategy entirely. |
| 1307 | `_allocateWorkspace(): void` | (no direct ngspice equivalent — embedded in `spOrderAndFactor`) | diff (digiTS-only) | TS comment admits "no direct equivalent". Resizes `_scratch` only; ngspice does workspace alloc in `spcCreateInternalVectors` (spfactor.c:706+). |

---

## 3. Per-line table

### 3a. Lines 1–505 (header, types, class fields, constructor, allocElement, _spcFindElementInCol, _spcCreateElement, stampElement, stampRHS)

JSDoc/comment lines, blank lines, and pure-`{`/`}` lines are excluded per the rules. Lines beginning with `//` are comment-only and excluded. Multi-line `/** ... */` JSDoc blocks are excluded.

| TS line | TS source | ngspice file:line | Class | Notes |
|---|---|---|---|---|
| 56 | `export interface FactorResult {` | n/a | diff | digiTS-only public type; ngspice returns `int` error code from `spFactor`/`spOrderAndFactor`. |
| 57 | `success: boolean;` | n/a | diff | digiTS-only field; C uses `Matrix->Error` int. |
| 58 | `conditionEstimate?: number;` | n/a | diff | digiTS-only; C condition number is a separate `spCondition` call. |
| 59 | `singularRow?: number;` | spdefs.h:773 `Matrix->SingularRow` | diff | Differs in being a return value vs. struct field accessed via `spWhereSingular`. |
| 64 | `singularCol?: number;` | spdefs.h:772 `Matrix->SingularCol` | diff | Same as above. |
| 70 | `error?: number;` | spdefs.h:744 `Matrix->Error` | diff | Field on result vs. matrix struct. |
| 78 | `usedReorder?: boolean;` | n/a | diff | digiTS-only. C distinguishes via the dispatch in `spFactor` (spfactor.c:333-335) implicitly. |
| 79 | `}` | n/a | diff | type closing brace. |
| 89 | `interface SpFactorReuseResult extends FactorResult {` | n/a | diff (digiTS-only) | C uses `ReorderingRequired = YES; break` inline; no result type. |
| 90 | `needsReorder?: boolean;` | spfactor.c:218 `ReorderingRequired = YES` | diff | digiTS field vs. C local var. |
| 91 | `rejectedAtStep?: number;` | implicit `Step` carry-through (spfactor.c:227→241) | diff | digiTS field vs. shared loop variable. |
| 92 | `}` | n/a | diff | type closing brace. |
| 97 | `export const spOKAY = 0;` | spmatrix.h `spOKAY` | match | Constant value mirrors. |
| 98 | `export const spSMALL_PIVOT = 2;` | spmatrix.h `spSMALL_PIVOT` | match | Constant. |
| 99 | `export const spZERO_DIAG = 3;` | spmatrix.h `spZERO_DIAG` | match | Constant. |
| 100 | `export const spSINGULAR = 4;` | spmatrix.h `spSINGULAR` | match | Constant. |
| 101 | `export const spMANGLED = 5;` | spmatrix.h `spMANGLED` | match | Constant. |
| 102 | `export const spNO_MEMORY = 6;` | spmatrix.h `spNO_MEMORY` | match | Constant. |
| 103 | `export const spPANIC = 7;` | spmatrix.h `spPANIC` | match | Constant. |
| 104 | `export const spFATAL = spPANIC;` | spmatrix.h `spFATAL` | match | Alias. |
| 119 | `const DEFAULT_PIVOT_REL_THRESHOLD = 1e-3;` | spconfig.h `DEFAULT_THRESHOLD` (used at spalloc.c:192) | match | Default constant value. |
| 120 | `const DEFAULT_PIVOT_ABS_THRESHOLD = 0.0;` | spalloc.c:193 | match | Default constant. |
| 122 | `export class SparseSolver {` | spdefs.h:733 `struct MatrixFrame` | diff | Struct vs. class; many fields differ in name/encoding. |
| 136 | `private _elRow: Int32Array = new Int32Array(0);` | spdefs.h MatrixElement.Row | diff | C uses linked struct with per-element `Row` int field; TS uses parallel typed array with index-based access. |
| 138 | `private _elCol: Int32Array = new Int32Array(0);` | spdefs.h MatrixElement.Col | diff | Same as above. |
| 140 | `private _elVal: Float64Array = new Float64Array(0);` | spdefs.h MatrixElement.Real | diff | Same as above. |
| 142 | `private _elNextInRow: Int32Array = new Int32Array(0);` | spdefs.h MatrixElement.NextInRow | diff | Same — int index vs. ElementPtr. |
| 144 | `private _elNextInCol: Int32Array = new Int32Array(0);` | spdefs.h MatrixElement.NextInCol | diff | Same — int index vs. ElementPtr. |
| 147 | `private _rowHead: Int32Array = new Int32Array(0);` | spdefs.h:751 `FirstInRow` | diff | Int32Array vs. ArrayOfElementPtrs. |
| 149 | `private _colHead: Int32Array = new Int32Array(0);` | spdefs.h:750 `FirstInCol` | diff | Int32Array vs. ArrayOfElementPtrs. |
| 151 | `private _diag: Int32Array = new Int32Array(0);` | spdefs.h:740 `Diag` | diff | Int32Array vs. ArrayOfElementPtrs; -1 sentinel vs. NULL. |
| 159 | `private _preorderColPerm: Int32Array = new Int32Array(0);` | spdefs.h:755 `IntToExtColMap` | diff | TS comment claims this matches IntToExtColMap; encoding & semantics overlap but the field is also used as a "preorder" buffer not in ngspice. |
| 167 | `private _extToIntCol: Int32Array = new Int32Array(0);` | spdefs.h:746 `ExtToIntColMap` | diff | ngspice gates this under `#if TRANSLATE`; TS unconditional. |
| 174 | `private _intToExtRow: Int32Array = new Int32Array(0);` | spdefs.h:756 `IntToExtRowMap` | diff | Mirrors a ngspice field but allocated unconditionally and used in non-translate contexts. |
| 181 | `private _extToIntRow: Int32Array = new Int32Array(0);` | spdefs.h:747 `ExtToIntRowMap` | diff | Same — ngspice gates under `#if TRANSLATE`. |
| 184 | `private _elCount: number = 0;` | spalloc.c:197 `ElementsRemaining` (inverse semantic) | diff | TS counts allocated; C counts remaining in current pool block. |
| 186 | `private _elCapacity: number = 0;` | implicit in `ELEMENTS_PER_ALLOCATION` block sizing | diff | digiTS-only doubling capacity counter; C uses fixed block sizes. |
| 198 | `private _elements: number = 0;` | spdefs.h:743 `Matrix->Elements` | match | Same counter semantics. |
| 199 | `private _originals: number = 0;` | spdefs.h:763 `Matrix->Originals` | match | Same counter semantics. |
| 200 | `private _fillins: number = 0;` | spdefs.h:749 `Matrix->Fillins` | match | Same counter semantics. |
| 205 | `private _rhs: Float64Array = new Float64Array(0);` | n/a | diff (digiTS-only) | ngspice MatrixFrame has no RHS field; RHS is owned by caller (CKTrhs). |
| 210 | `private _n = 0;` | spdefs.h:775 `Matrix->Size` | match | Same semantic. |
| 216 | `private _scratch: Float64Array = new Float64Array(0);` | spdefs.h:753 `Intermediate` | diff | TS allocates length n; C allocates `Size+1`. |
| 226 | `private _preSolveRhs: Float64Array \| null = null;` | n/a | diff (digiTS-only) | Instrumentation field; no C counterpart. |
| 227 | `private _capturePreSolveRhs = false;` | n/a | diff (digiTS-only) | Same. |
| 239 | `private _preFactorMatrix: Array<{...}> \| null = null;` | n/a | diff (digiTS-only) | Instrumentation; no C counterpart. |
| 240 | `private _capturePreFactorMatrix = false;` | n/a | diff (digiTS-only) | Same. |
| 283 | `private _needsReorder: boolean = false;` | spdefs.h:761 `Matrix->NeedsOrdering` | diff | C int (YES/NO) vs. TS bool; init value differs (C `spCreate` sets YES at spalloc.c:170, TS sets `false` at field init then `true` in `_initStructure:1120`). |
| 284 | `private _didPreorder: boolean = false;` | n/a (NIDIDPREORDER bit in CKTniState) | diff (digiTS-only) | Belongs to NI layer in ngspice (`niiter.c:854`), not to MatrixFrame. |
| 290 | `private _factored: boolean = false;` | spdefs.h:748 `Matrix->Factored` | diff | C int vs. TS bool. |
| 298 | `private _rowsLinked: boolean = false;` | spdefs.h:771 `Matrix->RowsLinked` | diff | C int vs. TS bool. |
| 300 | `private _structureEmpty: boolean = true;` | n/a | diff (digiTS-only) | Used as dispatch flag for `beginAssembly`'s create-vs-clear branch; not in ngspice MatrixFrame. |
| 302 | `private _workspaceN: number = -1;` | spdefs.h:754 `InternalVectorsAllocated` | diff | C uses bool flag; TS stores last-allocated size. |
| 310 | `private _relThreshold: number = DEFAULT_PIVOT_REL_THRESHOLD;` | spdefs.h:769 `RelThreshold` | match | Same field. |
| 318 | `private _absThreshold: number = DEFAULT_PIVOT_ABS_THRESHOLD;` | spdefs.h:735 `AbsThreshold` | match | Same field. |
| 326 | `private _error: number = spOKAY;` | spdefs.h:744 `Matrix->Error` | match | Same field, same init value. |
| 327 | `private _singularRow: number = 0;` | spdefs.h:773 `Matrix->SingularRow` | match | Same. |
| 328 | `private _singularCol: number = 0;` | spdefs.h:772 `Matrix->SingularCol` | match | Same. |
| 342 | `private _markowitzRow: Int32Array = new Int32Array(0);` | spdefs.h:757 `MarkowitzRow` | diff | C uses `int *` length `Size+1`; TS uses Int32Array length `n+2` (different sentinel layout). |
| 343 | `private _markowitzCol: Int32Array = new Int32Array(0);` | spdefs.h:758 `MarkowitzCol` | diff | Same — different array length. |
| 346 | `private _markowitzProd: Int32Array = new Int32Array(0);` | spdefs.h:759 `MarkowitzProd` | diff | C uses `long*`; TS uses Int32Array (32-bit). C length `Size+2`; TS length `n+2`. |
| 347 | `private _singletons: number = 0;` | spdefs.h:774 `Matrix->Singletons` | match | Same. |
| 353 | `constructor() {}` | n/a | diff (digiTS-only) | C `spCreate` is the factory; TS empty ctor. |
| 371 | `allocElement(row: number, col: number): number {` | spbuild.c:265 `spGetElement(...)` | diff | Returns int handle vs. `RealNumber*`. |
| 377 | `if (this._n === 0) {` | n/a | diff | digiTS-only guard; ngspice has `assert(IS_SPARSE(Matrix))` which is a different check. |
| 378 | `throw new Error(` | spbuild.c:270 `assert(...)` | diff | Throw vs. C assert. |
| 379 | `\`SparseSolver.allocElement(${row}, ${col}) called before \` +\`` | n/a | diff | Error message text — no C counterpart. |
| 380 | `\`beginAssembly(). Call solver.beginAssembly(matrixSize) first.\`,` | n/a | diff | Same. |
| 381 | `);` | n/a | diff | Throw close. |
| 382 | `}` | n/a | diff | If close. |
| 385 | `const internalCol = this._extToIntCol[col];` | spbuild.c:280 `Translate(Matrix, &Row, &Col)` | diff | TS only translates Col, not Row; ngspice `Translate` translates both. ngspice also gates this under `#if TRANSLATE`; TS does it unconditionally. No (Row==0 \|\| Col==0) → TrashCan short-circuit (spbuild.c:272) and no diagonal fast-path (spbuild.c:306) ahead of the call. |
| 386 | `return this._spcFindElementInCol(internalCol, row, /*createIfMissing=*/ true);` | spbuild.c:313-315 `spcFindElementInCol(Matrix, &Matrix->FirstInCol[Col], Row, Col, YES)` | diff | TS unconditionally dispatches into chain search; C wraps it in `if ((Row != Col) \|\| (Diag[Row]==NULL))` diagonal fast-path. The diagonal fast-path is missing from TS. |
| 387 | `}` | spbuild.c:318 `}` | diff | function close (semantic close mismatch — C function does more after the call). |
| 399 | `private _spcFindElementInCol(col: number, row: number, createIfMissing: boolean): number {` | spbuild.c:362-364 `spcFindElementInCol(MatrixPtr, ElementPtr*, int Row, int Col, int CreateIfMissing)` | diff | TS signature has 3 params (col, row, createIfMissing); C has 5 (Matrix, LastAddr-ptr-to-ptr, Row, Col, CreateIfMissing). |
| 400 | `let prev = -1;` | spbuild.c:369 `pElement = *LastAddr; ` (initial state, pre-walk) | diff | TS tracks `prev` as separate var; C threads `LastAddr` (pointer-to-pointer) so the splice address is implicit. |
| 401 | `let e = this._colHead[col];` | spbuild.c:369 `pElement = *LastAddr;` | diff | TS reads chain head via index lookup; C dereferences caller-supplied `LastAddr` which `spGetElement` initialised to `&Matrix->FirstInCol[Col]`. |
| 402 | `while (e >= 0 && this._elRow[e] < row) {` | spbuild.c:372-374 `while (pElement != NULL) { if (pElement->Row < Row)` | diff | TS fuses null check and row<target into single while predicate; C has a nested if/else-if/else-break with three branches (Row < Row, Row == Row return, else break). |
| 403 | `prev = e;` | spbuild.c:377 `LastAddr = &(pElement->NextInCol);` | diff | TS records prev index; C records pointer-to-NextInCol field. |
| 404 | `e = this._elNextInCol[e];` | spbuild.c:378 `pElement = pElement->NextInCol;` | match | Index walk vs. pointer walk, but identical operation. |
| 405 | `}` | spbuild.c:386 `}` | diff | Loop close — C loop has `else break` after Row==Row return; TS exits via while predicate. |
| 406 | `if (e >= 0 && this._elRow[e] === row) return e;` | spbuild.c:380-384 `else if (pElement->Row == Row) return pElement;` | diff | TS checks the equality after the loop; C checks inside the loop and returns from inside the loop. |
| 407 | `if (!createIfMissing) return -1;` | spbuild.c:389-392 `if (CreateIfMissing) return spcCreateElement(...); else return NULL;` | diff | TS returns -1 for "not found, don't create"; C returns NULL. Branch order inverted. |
| 408 | `return this._spcCreateElement(row, col, prev, /*fillin=*/ false);` | spbuild.c:390 `return spcCreateElement( Matrix, Row, Col, LastAddr, NO );` | diff | TS passes `prev` element index; C passes `LastAddr` pointer-to-pointer. |
| 409 | `}` | spbuild.c:393 | diff | function close. |
| 429 | `private _spcCreateElement(row, col, prevInCol, fillin): number {` | spbuild.c:767-769 `spcCreateElement(MatrixPtr, int Row, int Col, ElementPtr *LastAddr, int Fillin)` | diff | Signature: TS uses int prevInCol; C uses pointer-to-pointer LastAddr. No Matrix param (instance). Return: int vs. ElementPtr. |
| 432 | `const newE = this._newElement(row, col, 0, 0);` | spbuild.c:781/786/846 `pElement = spcGetFillin/Element(Matrix);` then 797-800/855-860 init | diff | TS `_newElement` fuses pool alloc with row/col/value init AND with `Diag[Row]=` set. C performs alloc, then in spcCreateElement explicitly assigns Row/Col/Real/Imag (spbuild.c:797-800 and 855-860). C has the alloc-vs-fillin dispatch *before* the init; TS fuses everything. |
| 435 | `if (prevInCol < 0) {` | spbuild.c:806 `pElement->NextInCol = *LastAddr;` (no branch — *LastAddr handles head case implicitly) | diff | TS branches on prev<0; C uses pointer-to-pointer indirection so head and middle are uniform. |
| 436 | `this._elNextInCol[newE] = this._colHead[col];` | spbuild.c:806 `pElement->NextInCol = *LastAddr;` | diff | TS explicitly reads colHead; C dereferences LastAddr (which equals `&FirstInCol[Col]` when at head). |
| 437 | `this._colHead[col] = newE;` | spbuild.c:807 `*LastAddr = pElement;` | diff | TS writes colHead directly; C writes through LastAddr pointer. |
| 438 | `} else {` | n/a | diff | C has no equivalent branch (uniform pointer-to-pointer). |
| 439 | `this._elNextInCol[newE] = this._elNextInCol[prevInCol];` | spbuild.c:806 (with LastAddr=&prev->NextInCol) | diff | TS explicit; C uniform. |
| 440 | `this._elNextInCol[prevInCol] = newE;` | spbuild.c:807 (with LastAddr=&prev->NextInCol) | diff | TS explicit; C uniform. |
| 441 | `}` | n/a | diff | else close. |
| 445 | `if (this._rowsLinked) this._insertIntoRow(newE, row);` | spbuild.c:776 `if (Matrix->RowsLinked) { ... }` (begins the entire RowsLinked branch) | diff | C gates the WHOLE alloc-and-init-and-splice block on RowsLinked (spbuild.c:776); TS gates only the row insert. C also runs `spcGetFillin` only when RowsLinked && Fillin (spbuild.c:781), uses `spcGetElement` otherwise (spbuild.c:786, 846). TS has no fillin-vs-element pool distinction, so this gate is structurally inverted. |
| 449 | `if (fillin) {` | spbuild.c:779 `if (Fillin)` | match | Same condition. |
| 450 | `this._fillins++;` | spbuild.c:782 `Matrix->Fillins++;` | match | Same op. |
| 451 | `} else {` | spbuild.c:784 `else` | match | Same branch. |
| 452 | `this._originals++;` | spbuild.c:787 `Matrix->Originals++;` | match | Same op. |
| 454 | `this._needsReorder = true;` | spbuild.c:788 `Matrix->NeedsOrdering = YES;` | match | Same op. |
| 455 | `}` | n/a | diff | else close. |
| 456 | `this._elements++;` | spbuild.c:870 `Matrix->Elements++;` | match | Same op. C places this AFTER the RowsLinked branches close (spbuild.c:870), which is the same structural position as TS. |
| 457 | `return newE;` | spbuild.c:871 `return pCreatedElement;` | match | Same op. |
| 458 | `}` | spbuild.c:872 | match | function close. |
| 467 | `stampElement(handle: number, value: number): void {` | spdefs.h spADD_REAL_ELEMENT macro | diff | TS function vs. C `+=` macro. |
| 468 | `this._elVal[handle] += value;` | spdefs.h `((ElementPtr)(p))->Real += val` | match | Same op semantics. |
| 469 | `}` | n/a | diff | function close. |
| 474 | `stampRHS(row: number, value: number): void {` | n/a | diff (digiTS-only) | No ngspice equivalent. |
| 475 | `this._rhs[row] += value;` | n/a | diff (digiTS-only) | Same. |
| 476 | `}` | n/a | diff (digiTS-only) | Same. |
| 505 | `beginAssembly(size: number): void {` | spbuild.c:96 `spClear(MatrixPtr)` (steady-state) **+** spalloc.c:117 `spCreate(...)` (first call) | diff | Two ngspice entry points fused behind a flag. |

### 3b. Lines 1068–1338 (_initStructure, _resetForAssembly, _newElement, _insertIntoRow, _createFillin, _insertIntoCol, _growElements, _allocateWorkspace)

| TS line | TS source | ngspice file:line | Class | Notes |
|---|---|---|---|---|
| 1068 | `private _initStructure(n: number): void {` | spalloc.c:117 `spCreate(int Size, int Complex, int *pError)` | diff | TS takes only n; C takes Size, Complex, pError. No return value vs. MatrixPtr. |
| 1070 | `this._rhs = new Float64Array(n);` | n/a | diff | digiTS-only RHS allocation; not in spCreate. |
| 1072 | `const elCap = Math.max(n * 4, 64);` | spalloc.c:263-264 `SPACE_FOR_ELEMENTS*AllocatedSize` (call to InitializeElementBlocks) | diff | TS uses `n*4`; C uses `SPACE_FOR_ELEMENTS*AllocatedSize` constant. Different sizing constant, no `MAX(Size, MINIMUM_ALLOCATED_SIZE)` step. |
| 1073 | `this._elRow = new Int32Array(elCap);` | spalloc.c:411 `SP_MALLOC(struct MatrixElement, InitialNumberOfElements)` | diff | TS allocates parallel-array slice; C allocates struct array. |
| 1074 | `this._elCol = new Int32Array(elCap);` | (same allocation in C) | diff | Same. |
| 1075 | `this._elVal = new Float64Array(elCap);` | (same allocation in C) | diff | Same. |
| 1076 | `this._elNextInRow = new Int32Array(elCap).fill(-1);` | (same allocation; C struct field defaults to NULL via SP_MALLOC then assigned per-element later) | diff | TS bulk-fills -1 sentinels; C does not bulk-init. |
| 1077 | `this._elNextInCol = new Int32Array(elCap).fill(-1);` | (same) | diff | Same. |
| 1078 | `this._elCapacity = elCap;` | spalloc.c:414 `Matrix->ElementsRemaining = InitialNumberOfElements;` | diff | TS records capacity total; C records remaining count. |
| 1079 | `this._elCount = 0;` | spalloc.c:415 `Matrix->NextAvailElement = pElement;` | diff | TS counts from 0 up; C uses pointer that increments. |
| 1082 | `this._elements = 0;` | spalloc.c:165 `Matrix->Elements = 0;` | match | Same. |
| 1083 | `this._originals = 0;` | spalloc.c:167 `Matrix->Originals = 0;` | match | Same. |
| 1084 | `this._fillins = 0;` | spalloc.c:168 `Matrix->Fillins = 0;` | match | Same. |
| 1086 | `this._rowHead = new Int32Array(n).fill(-1);` | spalloc.c:225 `SP_CALLOC(Matrix->FirstInRow, ElementPtr, SizePlusOne);` | diff | TS length n; C length Size+1. SP_CALLOC zero-inits (zero pointer = NULL); TS fills -1. |
| 1087 | `this._colHead = new Int32Array(n).fill(-1);` | spalloc.c:220 `SP_CALLOC(Matrix->FirstInCol, ElementPtr, SizePlusOne);` | diff | Same — length and sentinel encoding differ. |
| 1088 | `this._diag = new Int32Array(n).fill(-1);` | spalloc.c:215 `SP_CALLOC(Matrix->Diag, ElementPtr, SizePlusOne);` | diff | Same. |
| 1089 | `this._preorderColPerm = new Int32Array(n);` | spalloc.c:230 `SP_MALLOC(int, SizePlusOne)` for IntToExtColMap | diff | Length differs (n vs Size+1); allocator differs. |
| 1090 | `this._extToIntCol = new Int32Array(n);` | spalloc.c:246 `SP_MALLOC(int, SizePlusOne)` for ExtToIntColMap (gated `#if TRANSLATE`) | diff | TS allocates unconditionally; C only under TRANSLATE. Length differs. |
| 1091 | `for (let i = 0; i < n; i++) {` | spalloc.c:238 `for (I = 1; I <= AllocatedSize; I++)` | diff | TS 0-based loop; C 1-based; bounds equivalent in count but indexing convention differs. |
| 1092 | `this._preorderColPerm[i] = i;` | spalloc.c:241 `Matrix->IntToExtColMap[I] = I;` | diff | TS init `[i]=i`; C inits `[I]=I` with 1-based. |
| 1093 | `this._extToIntCol[i] = i;` | spalloc.c:255 `Matrix->ExtToIntColMap[I] = -1;` | diff | TS inits identity; C inits -1 (under `#if TRANSLATE`). Materially different value. |
| 1094 | `}` | spalloc.c:242 `}` | diff | loop close. |
| 1097 | `this._scratch = new Float64Array(n);` | not in spCreate; allocated later in spcCreateInternalVectors (spfactor.c:706+) Intermediate field | diff | TS allocates Intermediate-equivalent here in init; C defers to spcCreateInternalVectors. |
| 1099 | `this._markowitzRow = new Int32Array(n + 2);` | not in spCreate; spfactor.c:730 `SP_MALLOC(MarkowitzRow, int, Size+2)` | diff | C allocates these in spcCreateInternalVectors. Sizes match (n+2 ↔ Size+2). |
| 1100 | `this._markowitzCol = new Int32Array(n + 2);` | spfactor.c:734 `SP_MALLOC(MarkowitzCol, int, Size+2)` | diff | Same out-of-routine allocation. |
| 1101 | `this._markowitzProd = new Int32Array(n + 2);` | spfactor.c:738 `SP_MALLOC(MarkowitzProd, long, Size+2)` | diff | Same; ALSO C uses long, TS uses int32. |
| 1106 | `this._intToExtRow = new Int32Array(n);` | spalloc.c:234 `SP_MALLOC(IntToExtRowMap, int, SizePlusOne)` | diff | Length n vs Size+1; allocator differs. |
| 1107 | `this._extToIntRow = new Int32Array(n);` | spalloc.c:250 `SP_MALLOC(ExtToIntRowMap, int, SizePlusOne)` (`#if TRANSLATE`) | diff | TS unconditional; C gated. Length and sentinel differ. |
| 1108 | `for (let i = 0; i < n; i++) {` | spalloc.c:238 / spalloc.c:254 | diff | Two C loops fused into one TS loop. |
| 1109 | `this._intToExtRow[i] = i;` | spalloc.c:240 `Matrix->IntToExtRowMap[I] = I;` | diff | 0-based vs 1-based. |
| 1110 | `this._extToIntRow[i] = i;` | spalloc.c:256 `Matrix->ExtToIntRowMap[I] = -1;` | diff | TS inits identity; C inits -1. Materially different value. |
| 1111 | `}` | n/a | diff | loop close. |
| 1113 | `this._structureEmpty = false;` | n/a | diff (digiTS-only) | No counterpart field. |
| 1116 | `this._factored = false;` | spalloc.c:164 `Matrix->Factored = NO;` | match | Same op. |
| 1118 | `this._rowsLinked = false;` | spalloc.c:173 `Matrix->RowsLinked = NO;` | match | Same op. |
| 1120 | `this._needsReorder = true;` | spalloc.c:170 `Matrix->NeedsOrdering = YES;` | match | Same op. |
| 1121 | `this._didPreorder = false;` | n/a | diff (digiTS-only) | NIDIDPREORDER lives in CKTniState (NI layer). |
| 1123 | `this._error = spOKAY;` | spalloc.c:166 `Matrix->Error = *pError;` (where *pError = spOKAY at 127) | match | Same. |
| 1124 | `this._singularRow = 0;` | spalloc.c:176 `Matrix->SingularRow = 0;` | match | Same. |
| 1125 | `this._singularCol = 0;` | spalloc.c:175 `Matrix->SingularCol = 0;` | match | Same. |
| 1126 | `}` | spalloc.c:277 `}` | diff | function close — TS body radically shorter than C body which also init's many other MatrixFrame fields (ID, Complex, AllocatedSize, ExtSize, etc.). |
| 1144 | `private _resetForAssembly(): void {` | spbuild.c:97 `spClear(MatrixPtr Matrix)` | match | Same routine entry. |
| 1145 | `const n = this._n;` | spbuild.c:108 `for (I = Matrix->Size; ...)` (Size cached) | match | Local cache of Size. |
| 1147 | `for (let i = n - 1; i >= 0; i--) {` | spbuild.c:121 `for (I = Matrix->Size; I > 0; I--)` (real branch) | match | Reverse column walk. |
| 1148 | `let e = this._colHead[i];` | spbuild.c:123 `pElement = Matrix->FirstInCol[I];` | match | Same op. |
| 1149 | `while (e >= 0) {` | spbuild.c:124 `while (pElement != NULL)` | match | Same loop. |
| 1150 | `this._elVal[e] = 0;` | spbuild.c:126 `pElement->Real = 0.0;` | match | Same op. |
| 1151 | `e = this._elNextInCol[e];` | spbuild.c:127 `pElement = pElement->NextInCol;` | match | Same op. |
| 1152 | `}` | spbuild.c:128 | match | inner loop close. |
| 1153 | `}` | spbuild.c:129 | match | outer loop close. |
| 1155 | `this._factored = false;` | spbuild.c:137 `Matrix->Factored = NO;` | match | Same op. |
| 1157 | `this._error = spOKAY;` | spbuild.c:136 `Matrix->Error = spOKAY;` | match | Same op. |
| 1158 | `this._singularRow = 0;` | spbuild.c:139 `Matrix->SingularRow = 0;` | match | Same op. |
| 1159 | `this._singularCol = 0;` | spbuild.c:138 `Matrix->SingularCol = 0;` | match | Same op. |
| 1160 | `}` | spbuild.c:142 | match | function close. Note C also sets `TrashCan.Real=0`, `TrashCan.Imag=0` (133-134), `PreviousMatrixWasComplex` (140); TS omits these (no TrashCan, real-only solver). |
| 1177 | `private _newElement(row, col, val, _flags): number {` | spalloc.c:310 `spcGetElement(MatrixPtr)` + per-element init in spcCreateElement | diff | Fused responsibilities, dead `_flags` param, return int vs. ElementPtr. |
| 1178 | `if (this._elCount >= this._elCapacity) this._growElements();` | spalloc.c:319 `if (Matrix->ElementsRemaining == 0) {...}` | diff | TS check is doubling-array overflow; C is fixed-block-pool exhaustion triggering new SP_MALLOC. |
| 1179 | `const e = this._elCount++;` | spalloc.c:362 `return Matrix->NextAvailElement++;` | diff | TS post-increments index counter; C post-increments pointer. |
| 1180 | `this._elRow[e] = row;` | spbuild.c:797 / spbuild.c:855 `pElement->Row = Row;` | diff | TS does it inside `_newElement`; C does it in spcCreateElement. |
| 1181 | `this._elCol[e] = col;` | spbuild.c:798 / spbuild.c:857 `pElement->Col = Col;` | diff | Same. C in unlinked branch wraps Col assignment with `#if DEBUG` (spbuild.c:856-858) — only assigned in DEBUG builds; TS always assigns. |
| 1182 | `this._elVal[e] = val;` | spbuild.c:799 / spbuild.c:859 `pElement->Real = 0.0;` | diff | TS takes val parameter; C hardcodes 0.0. Caller of TS always passes 0 in this batch but the API allows non-zero. |
| 1183 | `this._elNextInRow[e] = -1;` | not initialised in spcCreateElement at this point (assigned later when spliced) | diff | TS pre-fills sentinel; C leaves uninitialised until splice. |
| 1184 | `this._elNextInCol[e] = -1;` | spbuild.c:806 `pElement->NextInCol = *LastAddr;` (assigned during splice) | diff | TS pre-fills sentinel; C assigns it during the splice in spcCreateElement, not in spcGetElement. |
| 1188 | `if (row === col) this._diag[col] = e;` | spbuild.c:793 / spbuild.c:851 `if (Row == Col) Matrix->Diag[Row] = pElement;` | diff | Same operation but on different index — C uses `Diag[Row]`, TS uses `_diag[col]`. Since row==col both lookups equal, but the indexing convention differs from the C source text. C does this in spcCreateElement; TS in `_newElement`. |
| 1189 | `return e;` | spalloc.c:362 `return Matrix->NextAvailElement++;` | diff | Same return semantic; different machinery. |
| 1190 | `}` | spalloc.c:364 | diff | function close. |
| 1202 | `private _insertIntoRow(e: number, row: number): void {` | spbuild.c:809-837 (inline body inside spcCreateElement RowsLinked branch) | diff | Standalone TS function vs. inline C block; never separately callable in C. |
| 1203 | `const eCol = this._elCol[e];` | spbuild.c:815 `if (pElement->Col < Col)` (Col is loop-invariant param) | diff | TS reads back from element; C uses parameter directly. |
| 1204 | `let prev = -1;` | spbuild.c:811 `pLastElement = NULL;` | match | Same. |
| 1205 | `let cur = this._rowHead[row];` | spbuild.c:810 `pElement = Matrix->FirstInRow[Row];` | match | Same op (named `cur` vs. `pElement`). |
| 1206 | `while (cur >= 0 && this._elCol[cur] < eCol) {` | spbuild.c:812-815 `while (pElement != NULL) { if (pElement->Col < Col) {` | diff | TS fuses null check and Col<target into single while predicate; C uses nested if with `else pElement = NULL` to break. |
| 1207 | `prev = cur;` | spbuild.c:818 `pLastElement = pElement;` | match | Same. |
| 1208 | `cur = this._elNextInRow[cur];` | spbuild.c:819 `pElement = pElement->NextInRow;` | match | Same. |
| 1209 | `}` | spbuild.c:822 | diff | C loop close has a different structure (`else pElement = NULL` in the inner if). |
| 1210 | `this._elNextInRow[e] = cur;` | spbuild.c:829 / 835 `pElement->NextInRow = Matrix->FirstInRow[Row];` / `pElement->NextInRow = pLastElement->NextInRow;` | diff | TS uses `cur` value; C uses different RHS depending on first-in-row branch. |
| 1211 | `if (prev < 0) this._rowHead[row] = e;` | spbuild.c:826-830 `if (pLastElement == NULL) { ... Matrix->FirstInRow[Row] = pElement;}` | diff | TS branch on prev<0; C branch on pLastElement==NULL. Same condition different encoding. |
| 1212 | `else this._elNextInRow[prev] = e;` | spbuild.c:836 `pLastElement->NextInRow = pElement;` | match | Same op. |
| 1213 | `}` | spbuild.c:837 | diff | function close (vs. inline block close). |
| 1232 | `private _createFillin(row: number, col: number): number {` | spfactor.c:2799 `CreateFillin(MatrixPtr, int, int)` (out of file) | diff (out-of-batch) | ngspice CreateFillin is in spfactor.c. |
| 1238 | `let prev = -1;` | spfactor.c (inside CreateFillin walk) | diff | Same. |
| 1239 | `let cur = this._colHead[col];` | spfactor.c CreateFillin | diff | Same. |
| 1240 | `while (cur >= 0 && this._elRow[cur] < row) {` | spfactor.c CreateFillin walk | diff | Same. |
| 1241 | `prev = cur;` | spfactor.c CreateFillin | diff | Same. |
| 1242 | `cur = this._elNextInCol[cur];` | spfactor.c CreateFillin | diff | Same. |
| 1243 | `}` | spfactor.c | diff | loop close. |
| 1244 | `const fe = this._spcCreateElement(row, col, prev, /*fillin=*/ true);` | spfactor.c:2810 (calls spcCreateElement with Fillin=YES) | diff | Same dispatch. |
| 1247 | `this._markowitzRow[row] += 1;` | spfactor.c:2818 `Matrix->MarkowitzRow[Row]++;` | diff (out-of-file) | Same op but ngspice ref out of batch scope. |
| 1248 | `this._markowitzProd[row] = this._markowitzRow[row] * this._markowitzCol[row];` | spfactor.c:2819 | diff (out-of-file) | Same op. |
| 1249 | `if (this._markowitzRow[row] === 1 && this._markowitzCol[row] !== 0) {` | spfactor.c:2820 | diff (out-of-file) | Same. |
| 1250 | `this._singletons -= 1;` | spfactor.c:2821 `Matrix->Singletons--;` | diff (out-of-file) | Same. |
| 1251 | `}` | n/a | diff | if close. |
| 1252 | `this._markowitzCol[col] += 1;` | spfactor.c:2823 `Matrix->MarkowitzCol[Col]++;` | diff (out-of-file) | Same. |
| 1253 | `this._markowitzProd[col] = this._markowitzCol[col] * this._markowitzRow[col];` | spfactor.c:2824 | diff (out-of-file) | Same. |
| 1254 | `if (this._markowitzRow[col] !== 0 && this._markowitzCol[col] === 1) {` | spfactor.c:2825 | diff (out-of-file) | Same. |
| 1255 | `this._singletons -= 1;` | spfactor.c:2826 | diff (out-of-file) | Same. |
| 1256 | `}` | n/a | diff | if close. |
| 1258 | `return fe;` | spfactor.c (return from CreateFillin) | diff (out-of-file) | Same. |
| 1259 | `}` | spfactor.c | diff | function close. |
| 1265 | `private _insertIntoCol(e: number, col: number): void {` | n/a — no ngspice function with this signature | diff (digiTS-only) | C does column splice as inline `*LastAddr=pElement` (spbuild.c:807) once the LastAddr is already known. |
| 1266 | `const eRow = this._elRow[e];` | n/a | diff | digiTS-only helper. |
| 1267 | `let prev = -1;` | n/a | diff | Same. |
| 1268 | `let cur = this._colHead[col];` | n/a | diff | Same. |
| 1269 | `while (cur >= 0 && this._elRow[cur] < eRow) {` | n/a (similar pattern to spbuild.c:372-378 walk) | diff | Helper duplicates the column-walk logic from `_spcFindElementInCol`. |
| 1270 | `prev = cur;` | n/a | diff | Same. |
| 1271 | `cur = this._elNextInCol[cur];` | n/a | diff | Same. |
| 1272 | `}` | n/a | diff | loop close. |
| 1273 | `this._elNextInCol[e] = cur;` | n/a | diff | Same. |
| 1274 | `if (prev < 0) this._colHead[col] = e;` | n/a | diff | Same. |
| 1275 | `else this._elNextInCol[prev] = e;` | n/a | diff | Same. |
| 1276 | `}` | n/a | diff | function close. |
| 1278 | `private _growElements(): void {` | spalloc.c:319-325 (block alloc when ElementsRemaining==0) | diff | TS doubles existing array; C allocates new fixed-size block. Fundamentally different memory model. |
| 1279 | `const newCap = Math.max(this._elCapacity * 2, 64);` | spalloc.c:323 `Matrix->ElementsRemaining = ELEMENTS_PER_ALLOCATION;` | diff | TS doubles; C uses constant. |
| 1280 | `const growI = (old: Int32Array): Int32Array => {` | n/a | diff | digiTS-only inner function for typed-array realloc. |
| 1281 | `const a = new Int32Array(newCap);` | n/a | diff | digiTS-only. |
| 1282 | `a.set(old);` | n/a | diff | TS copies all old data; C does NOT copy because old block is still alive — C just allocates a new block and threads it via `pListNode->Next`. |
| 1283 | `return a;` | n/a | diff | Same. |
| 1284 | `};` | n/a | diff | Closure close. |
| 1285 | `const growF = (old: Float64Array): Float64Array => {` | n/a | diff | digiTS-only. |
| 1286 | `const a = new Float64Array(newCap);` | n/a | diff | Same. |
| 1287 | `a.set(old);` | n/a | diff | Same — copy semantics divergent from C. |
| 1288 | `return a;` | n/a | diff | Same. |
| 1289 | `};` | n/a | diff | Closure close. |
| 1290 | `this._elRow = growI(this._elRow);` | n/a | diff | digiTS-only realloc. |
| 1291 | `this._elCol = growI(this._elCol);` | n/a | diff | Same. |
| 1292 | `this._elVal = growF(this._elVal);` | n/a | diff | Same. |
| 1293 | `this._elNextInRow = growI(this._elNextInRow);` | n/a | diff | Same. |
| 1294 | `this._elNextInCol = growI(this._elNextInCol);` | n/a | diff | Same. |
| 1295 | `this._elCapacity = newCap;` | n/a | diff | Same. |
| 1296 | `}` | n/a | diff | function close. |
| 1307 | `private _allocateWorkspace(): void {` | spfactor.c:706 spcCreateInternalVectors (out-of-file) | diff | TS comment admits "no direct equivalent". |
| 1308 | `const n = this._n;` | spfactor.c:712 `Size = Matrix->Size;` | diff | Same op. |
| 1309 | `if (n === 0) return;` | n/a | diff | digiTS-only guard. |
| 1310 | `if (n === this._workspaceN) return;` | spfactor.c:713 `if (!Matrix->InternalVectorsAllocated) {...}` | diff | TS uses size-equality memo; C uses bool. |
| 1311 | `this._workspaceN = n;` | spfactor.c:744 `Matrix->InternalVectorsAllocated = YES;` | diff | TS records size; C records bool. |
| 1313 | `this._scratch = new Float64Array(n);` | spfactor.c:716 SP_MALLOC(Intermediate, RealNumber, Size+1) | diff | Length n vs Size+1; allocator differs. C also allocates MarkowitzRow/Col/Prod here (which TS allocates in _initStructure instead). |
| 1314 | `}` | spfactor.c:747 | diff | function close. |

---

## 4. Closing structural-drift summary

Top structural divergences in this batch, ordered by likely numerical impact:

1. **TS `allocElement` (sparse-solver.ts:386) skips ngspice's diagonal fast-path** (`spbuild.c:306` `if ((Row != Col) || ((pElement = Matrix->Diag[Row]) == NULL))`). All TS calls walk the column chain even when an element already exists at the diagonal; C short-circuits via `Diag[Row]`.
2. **TS `allocElement` (sparse-solver.ts:385) translates Col but not Row** (`_extToIntCol[col]`); ngspice `Translate` (`spbuild.c:436-504`) translates BOTH external Row and external Col. Asymmetric translation breaks the row/col symmetry of MNA stamping under any non-identity row permutation.
3. **TS `allocElement` (sparse-solver.ts:371-387) skips ngspice's `Row==0 || Col==0 → TrashCan` short-circuit** (`spbuild.c:272-273`). Ground-node stamps that ngspice silently routes to scratch will hit `_extToIntCol[0]` in TS and produce a real element insertion at slot 0.
4. **TS `_initStructure` (sparse-solver.ts:1093) initialises `_extToIntCol[i]=i`** but ngspice `spCreate` (`spalloc.c:255-256`) initialises `ExtToIntColMap[I]=-1` (under `#if TRANSLATE`). With identity init, no caller ever triggers ngspice's "first time we see this external index" path at `spbuild.c:458`/`spbuild.c:480`.
5. **TS `_initStructure` (sparse-solver.ts:1110) initialises `_extToIntRow[i]=i`** vs ngspice `ExtToIntRowMap[I]=-1` (`spalloc.c:256`). Same divergence as above for the row map.
6. **TS `_spcCreateElement` (sparse-solver.ts:445) gates only the row insert on `_rowsLinked`**, while ngspice `spcCreateElement` (`spbuild.c:776`) gates the ENTIRE alloc-and-init-and-splice block on RowsLinked. C has TWO complete branches with their own counter writes; TS unifies. Counter writes (`Originals++`, `Fillins++`, `NeedsOrdering=YES`) live in different positions relative to the alloc.
7. **TS `_newElement` (sparse-solver.ts:1188) sets `_diag[col]=e`** for `row===col`. ngspice `spcCreateElement` writes `Diag[Row]=pElement` (`spbuild.c:793`/`851`). With non-identity row permutation the index used (`col` vs the C source text `Row`) becomes a substantive question — currently masked because `row===col` here.
8. **TS `_newElement` (sparse-solver.ts:1182) takes `val` parameter and writes it**; ngspice `spcCreateElement` (`spbuild.c:799`/`859`) hardcodes `pElement->Real = 0.0`. The TS API permits non-zero initial value at element creation.
9. **TS `_spcCreateElement` (sparse-solver.ts:432) calls `_newElement` BEFORE column splice**; ngspice `spcCreateElement` (`spbuild.c:786`/`797`-`807`) interleaves alloc, init, and splice. Order: C is `alloc → Diag → field-init → col-splice → row-splice`; TS is `alloc-with-Diag-with-field-init → col-splice → row-splice`.
10. **TS `_initStructure` (sparse-solver.ts:1099-1101) allocates Markowitz arrays in init**; ngspice allocates them in `spcCreateInternalVectors` (`spfactor.c:730+`) which is called LATER during the first reorder. TS does this work eagerly.
11. **TS `_initStructure` (sparse-solver.ts:1097) allocates `_scratch` (Intermediate-equivalent) here AND in `_allocateWorkspace`** (`sparse-solver.ts:1313`). ngspice allocates Intermediate exactly once in `spcCreateInternalVectors`.
12. **TS `_growElements` (sparse-solver.ts:1278-1296) doubles arrays and copies via `Int32Array.set`**; ngspice `spcGetElement` block allocator (`spalloc.c:319-325`) appends a NEW block to a linked list of blocks and never copies. Different memory model entirely. Element-pool reallocation invalidates any held element pointers in C; in TS it leaves indices stable but shifts the underlying buffer.
13. **TS `_initStructure` (sparse-solver.ts:1086-1088) chain heads use `-1` sentinel via `.fill(-1)`**; ngspice uses `SP_CALLOC` (`spalloc.c:215, 220, 225`) which zero-initialises (NULL pointer). Sentinel encoding differs across the entire codebase.
14. **TS `beginAssembly` (sparse-solver.ts:505) fuses `spCreate` and `spClear` behind a `_structureEmpty` flag**; ngspice has two separate entry points and the caller chooses. The flag-based dispatch hides which lifecycle call applies on any given NR iteration.
15. **TS `_resetForAssembly` (sparse-solver.ts:1144-1160) skips `spClear`'s TrashCan reset** (`spbuild.c:133-134` `Matrix->TrashCan.Real = 0.0`) and `PreviousMatrixWasComplex` update (`spbuild.c:140`). Real-only solver elides these, but the omission is structural.
16. **TS `_initStructure` (sparse-solver.ts:1068-1126) omits MatrixFrame field init** for ID, Complex, AllocatedSize, AllocatedExtSize, ExtSize, CurrentSize, Reordered, NumberOfInterchangesIsOdd, Partitioned, InternalVectorsAllocated, TrashCan, TopOfAllocationList, RecordsRemaining, ElementsRemaining (et al.). ngspice `spCreate` (`spalloc.c:160-200`) initialises ~25 fields; TS initialises 12.
17. **TS `_spcFindElementInCol` (sparse-solver.ts:399) signature drops the `LastAddr` pointer-to-pointer**; C `spcFindElementInCol` (`spbuild.c:362-364`) threads `LastAddr` through so the splice address is implicit. TS uses an int prev index recomputed locally.
18. **TS `_spcFindElementInCol` loop (sparse-solver.ts:402-405) fuses the three-branch C walk** (`spbuild.c:372-386`: `Row<Row` advance, `Row==Row` return-from-inside-loop, `else break`) into a single while predicate plus post-loop equality check. Different control flow shape.
19. **TS `_insertIntoRow` (sparse-solver.ts:1202) is extracted as a standalone helper**; in ngspice this code only exists inline inside the `RowsLinked` branch of `spcCreateElement` (`spbuild.c:809-837`).
20. **TS `_insertIntoCol` (sparse-solver.ts:1265-1276) is digiTS-only**; ngspice has no equivalent helper. Column splice in C is done inline as `*LastAddr=pElement` (`spbuild.c:807`) once the caller has provided LastAddr.
21. **TS `_newElement` (sparse-solver.ts:1180-1184) eagerly writes `_elNextInRow[e]=-1`, `_elNextInCol[e]=-1`**; ngspice leaves `NextInRow`/`NextInCol` uninitialised at alloc time and assigns them only during splice (`spbuild.c:806`/`829`/`835`).
22. **TS `_createFillin` (sparse-solver.ts:1238-1243) walks the column to find prev**, then dispatches to `_spcCreateElement`; ngspice `CreateFillin` (`spfactor.c:2798+`) calls `spcCreateElement` with the existing `LastAddr` from the caller's pivot-elimination loop. TS adds an extra walk that C does not perform.
23. **TS `_newElement` (sparse-solver.ts:1188) places `Diag[]` set inside `_newElement`**; ngspice places `Diag[Row]=pElement` inside `spcCreateElement` (`spbuild.c:793`/`851`). Different function-level home.
24. **TS `_newElement` (sparse-solver.ts:1177) parameter `_flags` is dead**; no ngspice counterpart exists for a per-element flag input to `spcGetElement` (`spalloc.c:310-364`). Vestigial parameter.
25. **TS `_factored` field (sparse-solver.ts:290), `_rowsLinked` field (sparse-solver.ts:298), and `_needsReorder` field (sparse-solver.ts:283) are TypeScript booleans**; ngspice MatrixFrame uses int (YES/NO) (`spdefs.h:748, 761, 771`). State-flag encoding differs across the entire codebase.
26. **TS `_didPreorder` (sparse-solver.ts:284) and `_structureEmpty` (sparse-solver.ts:300) are digiTS-only matrix-level flags**; ngspice's NIDIDPREORDER lives on `CKTniState` (NI layer), not on MatrixFrame. State ownership boundary differs.
27. **TS `_workspaceN` (sparse-solver.ts:302) stores the size last allocated**; ngspice `InternalVectorsAllocated` (`spdefs.h:754`) is a bool. Resizing semantics on n change differ.
28. **TS `_markowitzProd` (sparse-solver.ts:346) uses `Int32Array` (32-bit)**; ngspice `MarkowitzProd` (`spdefs.h:759`) is `long*` (64-bit on most platforms). Overflow semantics differ for very large matrices.
29. **TS `stampRHS` (sparse-solver.ts:474) and `_rhs` field (sparse-solver.ts:205) are digiTS-only**; ngspice's MatrixFrame holds no RHS — it is owned by `CKTrhs` and stamped by per-device load functions. The solver-vs-RHS ownership boundary is in a different place.
30. **TS adds instrumentation fields** (`_preSolveRhs`, `_capturePreSolveRhs`, `_preFactorMatrix`, `_capturePreFactorMatrix` at lines 226, 227, 239, 240) with no ngspice counterpart. Pure digiTS additions, but they make the class span larger than `MatrixFrame`.
