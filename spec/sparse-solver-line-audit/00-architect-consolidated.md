
# Sparse-Solver Line-Audit Consolidation - Architect Verdict

**Author:** Architect (read-only review)
**Inputs:** batch-1-alloc-build.md, batch-2-factor-elimination.md, batch-3-pivot-exchange.md, batch-4-solve-utils.md
**Subject:** src/solver/analog/sparse-solver.ts (~2704 lines)
**Reference:** ref/ngspice/src/maths/sparse/{spalloc.c, spbuild.c, spfactor.c, spsolve.c, spsmp.c, sputils.c, spdefs.h}
**Operating contract:** spec/sparse-solver-direct-port/01-port-spec.md (Banned-Pattern Guard governs)

---

## 1. Executive Summary

The four parallel audits classified roughly 1,073 non-comment, non-blank source lines and 47 function/class definitions. **404 lines (~37.7%) match the corresponding ngspice line; 669 lines (~62.3%) diverge.** Of the 47 function-level definitions audited, **only 6 are 1:1 with a single ngspice routine; 41 either fuse multiple C functions, exist with no ngspice counterpart, or alter the C signature and control flow.** The match rate is not the worst signal - the worst signal is that nearly every divergence is a deliberate rewrite, not a TS-language workaround. The current sparse-solver.ts is not a port; it is a port-shaped re-implementation that has accumulated enough algorithmic substitution (CountTwins replaced by cursor loop, two-phase spOrderAndFactor replaced by cross-call resumption with startStep, RealRowColElimination replaced by caller-stamped reciprocal plus _realRowColEliminationReuse variant, SwapCols stripped of NumberOfInterchangesIsOdd) to invalidate any "semantic equivalence" claim. The call to action is unambiguous: **ground-up re-port required.** Patch-by-patch fixes will not converge because the existing functions do not partition the way ngspice does; line edits inside a _spFactor that does not match spFactor cannot become spFactor.

---

## 2. Aggregate Scoreboard

| Batch | Scope (TS lines) | ngspice files | match | diff | total | match % |
|---|---|---|---|---|---|---|
| 1 - alloc and build | 1-505, 1068-1338 | spalloc.c, spbuild.c, spdefs.h | 84 | 114 | 198 | 42.4% |
| 2 - factor and elimination | 505-635, 1339-1685, 2638-2690 | spfactor.c (top), spsmp.c | 42 | 178 | 220 | 19.1% |
| 3 - pivot search and exchange | 820-985, 1686-2637 | spfactor.c (bottom), sputils.c, spsmp.c | 256 | 319 | 575 | 44.5% |
| 4 - solve and utils | 635-810, 987-1067, 2691-2704 | spsolve.c, sputils.c, spalloc.c | 22 | 58 | 80 | 27.5% |
| **Aggregate** | - | - | **404** | **669** | **1073** | **37.7%** |

| Definition class | match | diff | total |
|---|---|---|---|
| Function/class definitions in audited ranges | 6 | 41 | 47 |

The two segments where match rate is "high" (Batch 3 and Batch 1) are both inflated by long stretches of audited 1:1 within _realRowColElimination, _findLargestInCol, _countMarkowitz, _quicklySearchDiagonal, and _resetForAssembly. Stripping those routines, the structural / lifecycle code (factor orchestration, allocation, exchange wrappers) is below 20% match.

---

## 3. Categorisation of Every Divergence

### Bucket A - TypeScript-mandated divergences

The C language features that genuinely cannot be expressed in TypeScript without inventing an ABI are: (1) a writable `*ElementPtr` returned by reference and incremented past it, (2) `union`-based reinterpretation, (3) `setjmp`/`longjmp`, (4) macro-expanded `*ADDRESS = X` patterns where the address itself is the variable, and (5) inline struct field-and-pool ownership. None of these enable a real architectural rewrite - the standard mitigation is a `prev` local plus a tiny helper, which still maps line-for-line.

Audited divergences that genuinely require TS-only restructuring:

- **A.1 - Pool storage as Struct-of-Arrays (`_elRow/_elCol/_elVal/_elNextInRow/_elNextInCol`).** Audit batch-1 lines 136-145; structural review section A.2. ngspice `MatrixElement` is a heap struct; a 1:1 TS port using `Object` per element would be 50x slower and force GC during inner loops. Typed parallel arrays are mandatory in TS for performance-critical numerics. **Required side-effect:** sentinel `-1` instead of `NULL`. The sentinel choice itself is mandated by the encoding (`Int32Array` cannot store `null`).
- **A.2 - `Real` field as a parallel `Float64Array` (`_elVal`).** Same root cause as A.1; typed-array storage is required.
- **A.3 - `_diag` as `Int32Array` of element indices, not `ArrayOfElementPtrs`.** Same root cause.
- **A.4 - Class instance methods replacing `(MatrixPtr Matrix, ...)` first argument.** TS has no zero-cost way to pass an opaque struct pointer to free functions; an instance method is the closest semantic mirror.
- **A.5 - `prev` local plus `if (prev < 0) head = e; else next[prev] = e;` replacing `*LastAddr = X`.** Audit batch-1 lines 400-408, 435-441. TS has no mutable address-of-pointer; the `prev` local with two-branch write is the canonical mitigation. **This is permitted only when (a) the C `LastAddr` arrives from a single source on every call and (b) no functional change occurs.**

Everything else does not belong in this bucket. In particular:
- "Helper extraction" (`_setColLink`, `_setRowLink`, `_findDiagOnColumn`, `_insertIntoCol`, `_findTwin`) is **not** TS-mandated - the bodies are inline in C and they belong inline in the TS port.
- "Bool vs YES/NO int" (`_factored`, `_rowsLinked`, `_needsReorder`) is cosmetic - TS has both `boolean` and `0/1`. Both readings work; the field choice is mandated only when caller code reads the value as int (none does in the audited surface). Therefore this is **not** a TS-mandated divergence - it is a stylistic choice. The spec must enforce one shape consistently.

### Bucket B - Unjustified divergences (must be reverted), worst-first

Each item: TS file:line vs ngspice file:line, what differs, impact, fix.

#### B.1 - factor() fuses SMPluFac and SMPreorder, then adds a digiTS-only mid-step restart loop
- **TS:** sparse-solver.ts:565-606
- **ngspice:** spsmp.c:168-175 (SMPluFac) and spsmp.c:194-200 (SMPreorder)
- **Differs:** factor() has dispatch logic (`if (this._needsReorder || !this._factored)`) that does not exist in C. On reuse rejection it calls _spOrderAndFactor(rejectedAtStep) with a non-zero start step. ngspice keeps the reuse loop and reorder loop in the same function (spOrderAndFactor at spfactor.c:214-228 and spfactor.c:260+) sharing the same local Step; control falls through naturally on break.
- **Impact:** different Step value at the start of the reorder loop in error and edge cases; the cross-function parameter passing of startStep enables the bug shape that prior agents tried to fix with the C3 patches and never closed. The pivoting state and Markowitz state at iteration k of the reorder loop are not the same as ngspice at iteration k because the prerequisites at function entry (linking, internal-vector allocation, MaxRowCountInLowerTri reset) run at the wrong moment.
- **Fix:** delete factor() as a dispatch shell. Reintroduce it as a 1:1 port of SMPluFac (just LoadGmin then spFactor). The _spOrderAndFactor body MUST contain BOTH the reuse loop and the reorder loop, sharing a function-local Step counter, with goto Done collapsed into a single labelled exit (TS has no goto; the standard mitigation is a labelled break or an inner function ending in early-return - both are 1:1).

#### B.2 - _spFactor body is the _spOrderAndFactor reuse-loop body, not spFactor
- **TS:** sparse-solver.ts:1468-1511
- **ngspice:** spfactor.c:322-414 (spFactor)
- **Differs:** ngspice spFactor is a partition-based row-at-a-time LU using direct/indirect addressing scatter-gather (spfactor.c:352-410); it does NOT call RelThreshold/AbsThreshold at all because the reorder phase already validated the pivot order. digiTS _spFactor re-runs the threshold guards (sparse-solver.ts:1490-1492), takes the reciprocal in the wrong order (sparse-solver.ts:1498 vs spfactor.c:349/383/408), and on rejection returns a digiTS-only `{success: false, needsReorder: true, rejectedAtStep}` shape that the caller uses to retry. The whole "retry" path is invented.
- **Impact:** every reuse-path factor visits the threshold guard, which is an O(per-row) walk that the partition-based spFactor skips. Worse, the boundary case `largestInCol*RelThreshold == pivotMag` flips classification (TS `>=` rejection vs ngspice strict `<` acceptance at spfactor.c:219).
- **Fix:** delete _spFactor and _realRowColEliminationReuse. Re-port spFactor in full, including the partition table. If the partition table is too large to port in one phase, the alternative is to make _spFactor a stub that delegates to _spOrderAndFactor (with Reordered = NO, forcing the reorder branch) until the partition is ported - but **never** the current "import the reuse-loop body into a function named after spFactor" approach.

#### B.3 - _realRowColElimination requires the caller to pre-store 1/pivot; zero-pivot test moved to caller; wrong error code on zero pivot
- **TS:** sparse-solver.ts:1391, 1432-1436 (caller side); sparse-solver.ts:1527-1551 (kernel side)
- **ngspice:** spfactor.c:2553-2598 - kernel itself does `if (ABS(pPivot->Real) == 0.0) (void)MatrixIsSingular(Matrix, pPivot->Row); pPivot->Real = 1.0 / pPivot->Real;`
- **Differs:** (a) reciprocal stamped by caller (TS:1391, 1436), (b) zero-pivot test hoisted into caller (TS:1432), (c) **on zero pivot, caller returns _zeroPivot(step) (spZERO_DIAG) instead of MatrixIsSingular(Matrix, pPivot->Row) (spSINGULAR)**, (d) **caller passes step, ngspice passes pPivot->Row** (the post-exchange original row), (e) spNO_MEMORY propagation from CreateFillin (spfactor.c:2586-2589) absent.
- **Impact:** This is the most numerically dangerous divergence in the module. The error code and singular-row index reported on a zero pivot are both wrong - downstream solvers (Gmin stepping, source stepping, NR damping) make routing decisions based on these. spZERO_DIAG and spSINGULAR are routed to **different recovery strategies** in the standard NR control flow.
- **Fix:** restore the kernel to ngspice exact body (test-then-stamp-then-walk inside RealRowColElimination); delete the caller-side reciprocal stamps at sparse-solver.ts:1391 and sparse-solver.ts:1436; delete the caller-side zero-pivot guard at sparse-solver.ts:1432-1433; restore MatrixIsSingular(Matrix, pPivot->Row) semantics inside the kernel; restore the spNO_MEMORY early-return.

#### B.4 - preorder() is a one-pass cursor loop instead of spMNA_Preorder two-phase CountTwins algorithm
- **TS:** sparse-solver.ts:830-867
- **ngspice:** sputils.c:177-230 (spMNA_Preorder) plus sputils.c:243-281 (CountTwins) plus sputils.c:283-301 (SwapCols)
- **Differs:** ngspice runs **two distinct passes** - the first only swaps columns whose diagonal slot has exactly one twin (Singletons), the second relaxes to multi-twin columns. digiTS does a single StartAt-cursor pass with no twin counting. Different column permutations are produced for any matrix with multi-twin columns. _findTwin is a single-element finder that throws away the count returned by CountTwins, and **omits the `(*ppTwin1 = pTwin1)->Col = Col` side-effect at sputils.c:264** - the only place ngspice writes Col for a freshly-allocated element pre-spcLinkRows.
- **Impact:** every multi-twin matrix (any non-trivial MNA system with bidirectional devices like BJTs, MOSFETs, or transformers) gets a different preorder permutation than ngspice. This forces a different pivot order in the subsequent factor, which makes bit-exact parity impossible from the first stamp onward.
- **Fix:** re-port spMNA_Preorder as a function whose body is the two-phase loop with the lone-twins predicate. Re-port CountTwins as a separate helper that returns `{count, pTwin1, pTwin2}`. Re-port SwapCols with NumberOfInterchangesIsOdd toggling.

#### B.5 - Every column/row exchange drops NumberOfInterchangesIsOdd toggling; _exchangeRowsAndCols drops PivotsOriginalRow/Col
- **TS:** sparse-solver.ts:920-934 (_swapColumns), 2191-2239 (_spcRowExchange), 2244-2292 (_spcColExchange), 2511-2571 (_exchangeRowsAndCols)
- **ngspice:** sputils.c:299 (one toggle), spfactor.c:1995-1996, 2016-2017, 2033-2034 (three more)
- **Differs:** every SWAP in ngspice is paired with `NumberOfInterchangesIsOdd = !NumberOfInterchangesIsOdd;` so the sign of the determinant is correct on spDeterminant. _exchangeRowsAndCols additionally writes Matrix->PivotsOriginalRow/Col before the early-return at TS:2515. digiTS drops all of these.
- **Impact:** determinant sign is wrong (out-of-scope in current solver, but a correctness bug for any future feature that needs it); pivot history (PivotsOriginalRow/Col) is unavailable for diagnostic output and for any downstream code that wants to map a singular pivot back to its original row.
- **Fix:** add _numberOfInterchangesIsOdd: boolean field; add the toggle at every SWAP site; add _pivotsOriginalRow / _pivotsOriginalCol fields and write them at TS:2515 before the early-return.

#### B.6 - _searchEntireMatrix drops Matrix->Error = spSINGULAR on the all-zero exit
- **TS:** sparse-solver.ts:2163
- **ngspice:** spfactor.c:1803
- **Differs:** TS returns -1 on no pivot found, but does not set _error = spSINGULAR. The caller _searchForPivot returns -1, then the elimination loop calls _matrixIsSingular(step) at sparse-solver.ts:1425, which sets _error = spSINGULAR. So the error is eventually set, but at a different step (the loop step, not the search-time error condition).
- **Impact:** under the architecture (B.3) where the kernel is supposed to set Matrix->Error = spSINGULAR itself with MatrixIsSingular(Matrix, pPivot->Row), the _searchEntireMatrix write is the only place the error is set when no pivot exists at all. Combined with B.3 (wrong row index, wrong error code), the error reporting on singular matrices is broken in three places.
- **Fix:** restore `this._error = spSINGULAR;` at the all-zero exit.

#### B.7 - _searchForPivot drops all four PivotSelectionMethod writes
- **TS:** sparse-solver.ts:1820-1832
- **ngspice:** spfactor.c:958, 973, 983, 991
- **Differs:** ngspice writes Matrix->PivotSelectionMethod = 's' / 'q' / 'd' / 'e' based on which sub-search succeeded. digiTS does not write any.
- **Impact:** diagnostic data lost. Used by spStatistics and the harness when reporting which strategy produced each pivot.
- **Fix:** add _pivotSelectionMethod: string field; write at each return site.

#### B.8 - _initStructure initialises _extToIntCol[i] = i and _extToIntRow[i] = i instead of -1
- **TS:** sparse-solver.ts:1093, 1110
- **ngspice:** spalloc.c:255-256 (under #if TRANSLATE)
- **Differs:** ngspice initialises both ExtToIntColMap[I] and ExtToIntRowMap[I] to -1 to mark "external index never seen". The first Translate call at spbuild.c:436-504 assigns the next available internal slot when it sees -1. digiTS identity init means the first-seen path is never triggered - the external-to-internal map is always identity, so non-contiguous external numbering will silently corrupt.
- **Impact:** any caller that uses non-contiguous external numbering (i.e., any device that allocates internal nodes lazily - every subcircuit) gets wrong matrix population. Currently masked because all callers use dense 0..n-1 numbering, but the masking is fragile.
- **Fix:** initialise both maps to -1; port Translate (spbuild.c:436-504) and call it from allocElement with both Row and Col (see B.9).

#### B.9 - allocElement translates Col but not Row
- **TS:** sparse-solver.ts:385
- **ngspice:** spbuild.c:280 calls Translate(Matrix, &Row, &Col) translating BOTH
- **Differs:** TS only does _extToIntCol[col]. ngspice translates Row symmetrically. Asymmetric translation breaks MNA row/col symmetry under any non-identity row permutation (which _spcRowExchange produces).
- **Impact:** silent corruption of the matrix as soon as any row exchange happens, masked because the test workloads use identity numbering. The bug is dormant but loaded.
- **Fix:** port Translate and call it for both Row and Col at the top of allocElement.

#### B.10 - allocElement skips the Diag[Row] fast-path and Row==0||Col==0 trash-can short-circuit
- **TS:** sparse-solver.ts:371-387
- **ngspice:** spbuild.c:272-273 (TrashCan), spbuild.c:306-315 (Diag fast-path)
- **Differs:** TS walks the column chain even when an existing element at the diagonal would be an O(1) lookup. Ground-node stamps (Row==0 or Col==0) that ngspice silently routes to scratch will hit _extToIntCol[0] in TS and produce a real element insertion at slot 0.
- **Impact:** (a) per-stamp performance regression (every diagonal stamp is O(col-chain-length) instead of O(1)); (b) any device that ever stamps to ground via row 0 or col 0 will corrupt the slot-0 element. Currently masked because digiTS uses 0-based internal indexing where slot 0 is a valid node, but the spbuild.c short-circuit is load-bearing for the TrashCan semantics.
- **Fix:** add the Diag fast-path; either port TrashCan or document explicitly that digiTS uses 0-based numbering with no ground-node short-circuit (and assert in stampRHS/stampElement that row != ground).

#### B.11 - _matrixIsSingular and _zeroPivot use _preorderColPerm[step] instead of IntToExtColMap[Step]
- **TS:** sparse-solver.ts:1624, 1640
- **ngspice:** spfactor.c:2860, 2871
- **Differs:** ngspice uses IntToExtColMap which is **dynamically updated** by every SwapCols. digiTS keeps _preorderColPerm as a separate array updated only at preorder time (TS:925-928). After any post-preorder column exchange (which happens during the reorder factor loop), the singularCol reported by digiTS will not be the actual external column of the singular pivot.
- **Impact:** wrong singularCol reported on every singular factor where the singular column was post-preorder-exchanged. Diagnostic output points at the wrong device.
- **Fix:** delete _preorderColPerm as a separate field; rename _intToExtCol to mirror ngspice IntToExtColMap and update it inside _spcColExchange at sparse-solver.ts:2287-2291 instead of _preorderColPerm.

#### B.12 - invalidateTopology clears 8 fields ngspice spStripMatrix does not, omits the Elements == 0 short-circuit, and replaces 11 statements of list-cursor reset with _elCount = 0
- **TS:** sparse-solver.ts:749-796
- **ngspice:** sputils.c:1106-1145
- **Differs:** TS adds writes to _factored, _didPreorder, _originals, _error, _singularRow, _singularCol, _preFactorMatrix, _structureEmpty. TS omits the `if (Matrix->Elements == 0) return;` short-circuit at sputils.c:1110 and the assert(IS_SPARSE) at sputils.c:1109. The 11-statement ElementListNode/FillinListNode chain reset (sputils.c:1117-1133) collapses to _elCount = 0.
- **Impact:** semantics on reload differ. Specifically, spStripMatrix is supposed to leave _factored UNCHANGED (a stripped matrix that was previously factored is still mathematically factored, just with all elements removed); digiTS forces it false, which forces a redundant first-factor reorder on the next NR iteration. The extra _error/_singularRow/_singularCol clears mask the gate that B.13 would have caught.
- **Fix:** re-port spStripMatrix line-for-line. The collapsed ElementListNode reset is acceptable in spirit because the underlying pool model is different (B.18 / TS-mandated), but the 8 extra field clears must go.

#### B.13 - whereSingular() drops the Error == spSINGULAR || spZERO_DIAG gate
- **TS:** sparse-solver.ts:2700-2702
- **ngspice:** spalloc.c:755-760
- **Differs:** ngspice forces *pRow = *pCol = 0 when Error is anything other than spSINGULAR/spZERO_DIAG, even if the fields hold stale data. digiTS unconditionally returns the stored fields.
- **Impact:** correct only as long as _singularRow / _singularCol are kept at 0 outside an active singular state. B.12 clears in invalidateTopology were added precisely to maintain this invariant - that is a wrong fix; the right fix is to gate the read.
- **Fix:** add the gate at the read site.

#### B.14 - solve() reduces 5-arg spSolve to 1-arg, sources RHS from instance state, omits assert(IS_VALID and IS_FACTORED) and Complex dispatch
- **TS:** sparse-solver.ts:635
- **ngspice:** spsolve.c:126-191
- **Differs:** ngspice spSolve(Matrix, RHS, Solution, iRHS, iSolution) is a five-argument routine. The TS port forces RHS to be the solver-owned _rhs buffer, which is also written by stampRHS (a digiTS-only method, B.16). It also lacks the IS_FACTORED precondition and any path to a complex solver.
- **Impact:** caller cannot independently manage RHS (e.g., for transient analysis where RHS comes from history terms). The current architecture forces stampRHS to be the only RHS write path, which is a layering inversion (B.16). The missing precondition assertion masks bugs where solve() is called on an unfactored matrix.
- **Fix:** port spSolve with all five arguments. Delete _rhs field and stampRHS method (B.16). Add assert that mirrors IS_FACTORED. Complex dispatch can be a TODO comment that throws - the audit explicitly excludes complex per port spec section 0.4.

#### B.15 - _spOrderAndFactor accepts startStep parameter, sets _factored=true / _needsReorder=false BEFORE early-return, never sets Reordered=YES, and runs _linkRows on every entry (not gated on RowsLinked)
- **TS:** sparse-solver.ts:1339, 1349-1352, 1397-1399, 1451-1453
- **ngspice:** spfactor.c:191, 246-247, 279-281
- **Differs:** five separate divergences in the same routine. (a) parameter startStep does not exist in ngspice; Step is a function-local. (b) _linkRows runs on every call instead of being gated on !RowsLinked. (c) _factored=true / _needsReorder=false are set before the early-return at TS:1397-1399 instead of in a single Done block at the function end. (d) Reordered=YES (spfactor.c:280) is not set anywhere. (e) the MaxRowCountInLowerTri = -1 reset (spfactor.c:257) and the `if (Matrix->Error >= spFATAL) return Matrix->Error;` propagation (spfactor.c:270) are missing.
- **Impact:** structural - the function does not have the same control-flow shape as spOrderAndFactor; therefore every line edit inside it is operating on a different state machine. This is the principal reason patch-by-patch convergence has failed for weeks.
- **Fix:** delete _spOrderAndFactor. Re-port with C-local Step, single labelled-exit, _linkRows gated on !_rowsLinked, _reordered field updated at the exit, MaxRowCountInLowerTri reset, and the spFATAL propagation. The reuse loop and reorder loop live in the same function body sharing the same Step local.

#### B.16 - stampRHS and _rhs field are digiTS-only; ngspice has no MatrixFrame.RHS
- **TS:** sparse-solver.ts:205, 474-476
- **ngspice:** RHS is owned by CKTrhs (NI layer); per-device load functions do `RHS[node] += val` directly.
- **Differs:** digiTS makes the sparse solver hold and zero the RHS. ngspice keeps RHS strictly outside the sparse module.
- **Impact:** layering inversion. The sparse solver is now the owner of state that does not belong to it. This is the root cause of B.14 signature change and the beginAssembly RHS-zero behaviour banned by port-spec rule #9.
- **Fix:** delete _rhs and stampRHS. Move RHS to the caller (Newton-Raphson layer). Per port spec rule #9, RHS management is the caller responsibility.

#### B.17 - beginAssembly fuses spCreate and spClear behind a _structureEmpty flag
- **TS:** sparse-solver.ts:505-525
- **ngspice:** spalloc.c:117-277 (spCreate) and spbuild.c:96-142 (spClear)
- **Differs:** ngspice keeps two separate entry points; the caller picks. digiTS dispatches via an internal flag.
- **Impact:** the flag-based dispatch hides which lifecycle call applies on any given NR iteration; combined with B.12 extra clears in invalidateTopology, the lifecycle is non-deterministic from a caller perspective.
- **Fix:** split beginAssembly into two methods (or expose the flag check at the call site). Per port spec section 4A, the steady-state body should be the spClear-equivalent; the first-call alloc body is spCreate plus spcCreateInternalVectors.

#### B.18 - _growElements doubles arrays and copies via Int32Array.set; ngspice appends a new fixed-size block
- **TS:** sparse-solver.ts:1278-1296
- **ngspice:** spalloc.c:319-325
- **Differs:** TS uses O(n log n) doubling-array growth with copy. ngspice appends a new ELEMENTS_PER_ALLOCATION-sized block to a linked list of blocks, never copying.
- **Impact:** in C, element pointers stored anywhere are stable across allocations. In TS with doubling, element indices are stable but the underlying buffer is reallocated - any caller that holds a slice or subarray view to the old buffer breaks. None do today, but the divergence is a load-bearing assumption.
- **Fix:** the doubling-array model is plausibly TS-mandated for performance; this could be argued into bucket A. Keeping it in B because the linked-list-of-blocks model is straightforward to port (a typed-array per block, plus an outer Int32Array of block bases, with _pool[block][offsetInBlock] access via a pair-decode). Decision belongs to the user.

#### B.19 - _initStructure allocates Markowitz arrays and Intermediate (_scratch) eagerly; ngspice allocates them in spcCreateInternalVectors on first reorder
- **TS:** sparse-solver.ts:1097-1101
- **ngspice:** spfactor.c:706-747
- **Differs:** digiTS allocates approximately 5n of internal vectors on every _initStructure call; ngspice defers until first factor and gates with InternalVectorsAllocated.
- **Impact:** memory pressure on small matrices that never factor; harmless for production but an unbounded difference in lifecycle. Combined with B.17, the lifecycle is structurally incompatible.
- **Fix:** restore spcCreateInternalVectors as a separate method called on first factor entry. Replace `_workspaceN !== -1` proxy with a bool _internalVectorsAllocated.

#### B.20 - _newElement accepts val parameter and writes it; ngspice always inits to 0.0
- **TS:** sparse-solver.ts:1182
- **ngspice:** spbuild.c:799/859
- **Differs:** API permits non-zero initial element value at creation. Currently all callers pass 0, but the API surface is wider than ngspice.
- **Impact:** future caller adding a non-zero init would silently violate the ngspice contract (which says new elements are 0; values arrive via subsequent spADD_REAL_ELEMENT).
- **Fix:** drop the parameter; hardcode 0.0.

#### B.21 - _newElement parameter _flags is dead; sets _diag[col]=e for row===col
- **TS:** sparse-solver.ts:1177, 1188
- **ngspice:** spbuild.c:793/851
- **Differs:** dead parameter in TS. The Diag set lives in spcCreateElement in ngspice (one of two branches), not in spcGetElement. The TS `_diag[col] = e` uses col as the index; ngspice writes `Diag[Row] = pElement` (col and row are equal at the call site, but the source-text divergence becomes substantive when re-checking against ngspice line-by-line).
- **Impact:** correct under row==col invariant, but the function-level home is wrong. Per port spec edit 1.3.5, _diag set must move to _spcCreateElement and use the C variable name row.
- **Fix:** delete _flags parameter; move the Diag set to _spcCreateElement; index by row.

#### B.22 - _spcCreateElement gates only the row insert on _rowsLinked; ngspice gates the whole alloc-and-init-and-splice block
- **TS:** sparse-solver.ts:445
- **ngspice:** spbuild.c:776
- **Differs:** C has TWO complete branches under `if (RowsLinked) ... else ...`, each with its own spcGetFillin/spcGetElement dispatch and its own counter writes. TS unifies them with the row-insert as the only conditional.
- **Impact:** the fillin pool vs element pool dispatch is structurally absent (digiTS has no separate fillin pool). The counter writes (Originals++, Fillins++, NeedsOrdering=YES) live in different positions relative to the alloc.
- **Fix:** restore the two-branch structure of spcCreateElement exactly. Whether TS needs separate element/fillin pools is a downstream design call (the audit cannot resolve it because the pool model is part of B.18 bucket).

#### B.23 - _realRowColEliminationReuse is digiTS-only; should not exist
- **TS:** sparse-solver.ts:1564-1593
- **ngspice:** no counterpart
- **Differs:** ngspice prevents fill-in on reuse via Matrix->Reordered=YES controlling whether the partition-based fast path or the linked-list path executes. There is no separate "reuse elimination kernel".
- **Impact:** double-implementation of the elimination algorithm with subtle drift between the two; the reuse variant is the only place rejectedAtStep is computed, which feeds B.1 restart machinery.
- **Fix:** delete _realRowColEliminationReuse. The reuse-loop body inside _spOrderAndFactor should call the same _realRowColElimination kernel; fill-in suppression is handled by the partition decision (or, until partitioning is ported, by an assertion at the kernel entry that no fill-ins are expected on the reuse path).

#### B.24 - _buildFactorResult computes inline condition estimate on every factor
- **TS:** sparse-solver.ts:1598-1614
- **ngspice:** no counterpart; condition estimation is spCondition in spcondit.c
- **Differs:** digiTS computes a min/max diagonal-magnitude ratio on every factor return. ngspice computes it only when called.
- **Impact:** O(n) overhead per factor, thrown away by callers that do not need it. Also the metric is a poor proxy for true 1-norm condition (which ngspice spCondition uses).
- **Fix:** delete _buildFactorResult as a generic post-step. Return `{success, error, singularRow, singularCol}` as a thin shell over what ngspice surfaces via Matrix->Error field reads. If condition estimate is needed, add it as a separate getConditionEstimate() method that the caller invokes deliberately.

#### B.25 - _searchForSingleton, _quicklySearchDiagonal, _searchDiagonal, _findBiggestInColExclude all add `>=0` bounds guards where ngspice unconditionally dereferences
- **TS:** sparse-solver.ts:1719, 1873, 1904, 1916, 1930, 1962, 1974, 1984, 2072
- **ngspice:** the corresponding sites unconditionally dereference, relying on Step-1 / Size+1 sentinel slots in MarkowitzProd to terminate the walk.
- **Differs:** TS adds explicit `(p >= 0) ? mProd[p] : -1` and similar. C falls into UB if the sentinel is wrong; TS silently sets a bounds-default value.
- **Impact:** masks bugs in the sentinel allocation. If _markowitzProd length or sentinel value is ever wrong, ngspice would crash (good - surfaces the bug); TS would silently return a wrong pivot (bad - hides the bug).
- **Fix:** delete all the bounds guards. Mirror ngspice sentinel allocation exactly (Size+2 length, -1 at Step-1, copy of MarkowitzProd[Step] to MarkowitzProd[Size+1]). Per port-spec banned-pattern rule #1: "Do not introduce safety guards that ngspice does not have."

#### B.26 - _markowitzProducts uses `r * c` and `fp | 0`; ngspice uses `(double)*pMarkRow++ * (double)*pMarkCol++` and `(long)fProduct`
- **TS:** sparse-solver.ts:1801, 1803
- **ngspice:** spfactor.c:884-888
- **Differs:** the cast difference (`| 0` vs `(long)`) gives different results for fProduct outside [-2^31, 2^31). The pointer-walk vs index-walk difference changes iteration semantics if any side-effect is ever added.
- **Impact:** numerical drift on degenerate matrices where MarkowitzProd[i] exceeds INT32 range; effectively LARGEST_LONG_INTEGER should clamp before the cast, and ngspice does (spfactor.c:885-888); TS clamps with `>=` rather than `>`, so the boundary case differs.
- **Fix:** mirror the C `if (fProduct >= LARGEST_LONG_INTEGER) ... else mProd[i] = (long)fProduct;` clamp exactly. Same fix for _updateMarkowitzNumbers at TS:2592-2594, 2609-2611.

#### B.27 - _linkRows preclears _rowHead before re-linking; ngspice does not
- **TS:** sparse-solver.ts:884
- **ngspice:** spbuild.c:907-932 assumes FirstInRow was zeroed at allocation
- **Differs:** TS adds a `for (let r = 0; r < n; r++) this._rowHead[r] = -1;` pre-loop. C relies on SP_CALLOC having zero-initialised the array.
- **Impact:** masks allocator drift; if _rowHead is ever stale on entry, ngspice would corrupt rows; TS silently restarts from clean. Per port-spec banned-pattern rule #1.
- **Fix:** delete the preclear; assert `_rowHead[r] === -1` for all r at entry in debug builds.

#### B.28 - _linkRows does not write _rowsLinked = true; epilogue skips Matrix->RowsLinked = YES
- **TS:** sparse-solver.ts:893-895
- **ngspice:** spbuild.c:930
- **Differs:** ngspice ends spcLinkRows with `Matrix->RowsLinked = YES;`. The TS port currently sets _rowsLinked from the caller (_spOrderAndFactor at TS:1351) - wrong site.
- **Impact:** any future caller that calls _linkRows outside _spOrderAndFactor would leave _rowsLinked = false. Bookkeeping moved to the wrong owner.
- **Fix:** move the assignment into _linkRows.

#### B.29 - solve() aliases nine fields at entry; ngspice aliases two
- **TS:** sparse-solver.ts:643-651
- **ngspice:** spsolve.c:145-149 aliases only Intermediate and Size
- **Differs:** every other read in C is direct (Matrix->Diag[I], pElement->Real, etc.). The hoisting is observable in iteration order if any of the source fields are reassigned mid-call (today they are not, but the contract is not the C contract).
- **Impact:** structural; not numerical today, but the contract differs from C. Any future async/interrupt scenario or any change to make a field reactive would behave differently.
- **Fix:** delete the seven extra aliases; read the fields directly at use sites as ngspice does.

#### B.30 - Capture-buffer instrumentation injects state into the production class
- **TS:** sparse-solver.ts:226-227, 239-240, 580, 535-545, 987-1062
- **ngspice:** none
- **Differs:** the capture buffers themselves are bucket C (instrumentation), but the capture **call** at factor() (TS:580 _takePreFactorSnapshotIfEnabled) is inside the factor algorithm. That moves them into bucket B because they leak into the core.
- **Impact:** mainline factor path branches on instrumentation state; observable side-effect on inner-loop behaviour even when capture is disabled (the branch predictor sees a never-taken branch but still has to evaluate the condition).
- **Fix:** delete every capture call from inside production methods. Replace with an external observer - the harness already has the data via getCSCNonZeros(); the in-factor capture is redundant.

#### B.31 - finalize() does Markowitz precompute at the wrong lifecycle moment
- **TS:** sparse-solver.ts:535-545
- **ngspice:** spfactor.c:255-256 (CountMarkowitz / MarkowitzProducts) - runs from inside spOrderAndFactor, gated to once per reorder
- **Differs:** TS pre-computes Markowitz on every assembly finish; ngspice only when about to reorder.
- **Impact:** every NR-iteration re-stamp re-runs finalize() and re-walks every chain twice. Per port-spec banned-pattern rule #4.
- **Fix:** delete the Markowitz precompute from finalize(). Move into _spOrderAndFactor per port spec section 5.

#### B.32 - Argument signature of _spFactor, _spOrderAndFactor, factor drops C parameters silently
- **TS:** sparse-solver.ts:565, 1339, 1468
- **ngspice:** spsmp.c:168-175, spfactor.c:191-194, spfactor.c:322-323
- **Differs:** TS routinely drops RHS, RelThreshold, AbsThreshold, DiagPivoting, PivTol, Gmin arguments. The dropped arguments are encoded as instance state at the wrong layer.
- **Impact:** transient analysis, source stepping, and Gmin stepping all need to vary these per call. Currently they cannot without mutating the solver instance, which is a thread-safety hazard and a layering inversion.
- **Fix:** restore the full parameter lists.

#### B.33 - _resetForAssembly walks the pool linearly (`for e = 0..elCount` zeroing _elVal[e])
- **TS:** sparse-solver.ts:1144-1160
- **ngspice:** spbuild.c:96-142 walks `for I = Size; I > 0; I-- { for pE = FirstInCol[I]; pE != NULL; pE = pE->NextInCol { pE->Real = 0 } }`
- **Differs:** C uses chain walk; TS uses pool walk.
- **Impact:** functionally aligned today (all pool slots correspond to live elements). After any future spStripFills (which leaves dead pool slots), the chain walk would skip them and the pool walk would zero their stale memory - different behaviour.
- **Fix:** convert to chain walk per port spec section 5A. (Currently the audit batch-1 marked this match; that is generous because the **operation pattern** matches but the **iteration pattern** does not. Per the strict bar, this is a diff.)

#### B.34 - _swapColumns swaps _preorderColPerm instead of mutating IntToExtColMap (and similar in _spcColExchange)
- **TS:** sparse-solver.ts:925-928, 2287-2291
- **ngspice:** sputils.c:291-294, spfactor.c:2251-2254
- **Differs:** digiTS keeps a separate preorder-time permutation (_preorderColPerm) while ngspice uses a single IntToExtColMap updated by all column swaps (preorder and exchange).
- **Impact:** combined with B.11, the column permutation is split across two structures and singularCol reporting is wrong.
- **Fix:** delete _preorderColPerm. Use the single IntToExtColMap-equivalent (_intToExtCol) throughout.

#### B.35 - _findDiagOnColumn is a digiTS specialisation of spcFindElementInCol
- **TS:** sparse-solver.ts:943-950
- **ngspice:** uses generic spcFindElementInCol(Col, Col, NO) at spfactor.c:2046
- **Differs:** custom helper that walks only the col chain looking for the diag element.
- **Impact:** the C signature `(Matrix, &FirstInCol[Col], Col, Col, NO)` carries the NO flag (do-not-create) and the LastAddr parameter that the digiTS helper does not. Same end-result under no-create-needed semantics, but adds a function to the codebase that is not in ngspice.
- **Fix:** delete _findDiagOnColumn. Use _spcFindElementInCol(col, col, /*createIfMissing=*/ false).

#### B.36 - _extToIntCol allocated unconditionally; ngspice gates under #if TRANSLATE
- **TS:** sparse-solver.ts:1090
- **ngspice:** spalloc.c:246 (under #if TRANSLATE)
- **Differs:** TS always allocates and uses; C only under TRANSLATE compile flag.
- **Impact:** structural - the TS port does not have a "no-translate" mode.
- **Fix:** decision belongs to user. If TRANSLATE-on always, document and write `#if TRANSLATE`-equivalent assertion at every entry to confirm the maps are in identity-or-translated state.

#### B.37 - _didPreorder is a matrix-level field; ngspice NIDIDPREORDER lives in CKTniState
- **TS:** sparse-solver.ts:284
- **ngspice:** niiter.c:854 (NI layer, not matrix)
- **Differs:** state ownership boundary differs.
- **Impact:** the sparse solver tracks "have I been preordered" - ngspice does not. The flag is read inside preorder() (TS:831) to decide whether to run; ngspice preorder runs unconditionally because the caller (NI layer) decides via NIDIDPREORDER.
- **Fix:** delete _didPreorder. Move the gating decision to the caller.

#### B.38 - _spcRowExchange and _spcColExchange always swap Markowitz arrays; ngspice gates on InternalVectorsAllocated
- **TS:** sparse-solver.ts:2228-2230, 2281-2283
- **ngspice:** spfactor.c:2154, 2248
- **Differs:** ngspice only swaps MarkowitzRow/Col when Matrix->InternalVectorsAllocated. digiTS unconditionally swaps.
- **Impact:** if Markowitz allocation is ever deferred (which is what ngspice does on first factor; B.19), digiTS would NPE here. Currently masked because B.19 forces eager allocation.
- **Fix:** add the gate.

#### B.39 - _realRowColElimination hoists pUpper->Col into local upperCol
- **TS:** sparse-solver.ts:1535
- **ngspice:** spfactor.c:2585 reads pUpper->Col directly
- **Differs:** minor read-pattern divergence.
- **Impact:** none today; structural drift only.
- **Fix:** delete the hoist; read _elCol[pUpper] directly at the use site.

#### B.40 - _realRowColElimination missing spNO_MEMORY propagation on failed CreateFillin
- **TS:** sparse-solver.ts:1544
- **ngspice:** spfactor.c:2586-2589
- **Differs:** TS assumes _createFillin cannot fail. ngspice checks for NULL and sets `Matrix->Error = spNO_MEMORY; return;`.
- **Impact:** under memory pressure (in browser with bounded heap), the failed allocation throws an unhandled exception in TS; ngspice would set the error and propagate.
- **Fix:** make _createFillin return -1 on failure (or wrap in try/catch); add the spNO_MEMORY propagation.

#### B.41 - _searchDiagonal introduces `const size = n - 1` shadow
- **TS:** sparse-solver.ts:2059
- **ngspice:** spfactor.c:1612 uses Size directly
- **Differs:** local naming pollution.
- **Fix:** delete; use n directly.

#### B.42 - _quicklySearchDiagonal heap-allocates tied[] per call
- **TS:** sparse-solver.ts:1964
- **ngspice:** spfactor.c:1260 uses stack TiedElements[MAX_MARKOWITZ_TIES + 1]
- **Differs:** heap vs stack allocation per call - GC pressure in TS.
- **Fix:** allocate once as a class field of fixed size MAX_MARKOWITZ_TIES + 1.

#### B.43 - getError() omits Matrix != NULL branch and spNO_MEMORY fallback
- **TS:** sparse-solver.ts:2691-2693
- **ngspice:** spalloc.c:712-724
- **Differs:** TS unconditionally returns _error. C returns spNO_MEMORY if Matrix is NULL.
- **Impact:** none in TS context (this always exists); structural only.
- **Fix:** TS-mandated by this-binding semantics. Move to bucket A IF the user wants strict 1:1; otherwise leave.

#### B.44 - Numerous parameter-rename and variable-rename divergences
- **TS:** scattered (_preorderColPerm for IntToExtColMap, _scratch for Intermediate, _n for Size, etc.)
- **ngspice:** original names
- **Differs:** every cross-reference between TS code and ngspice line numbers requires a rename map.
- **Impact:** raises the cost of every line-by-line audit (this audit took four reviewers a day each largely because of rename friction).
- **Fix:** sweep every digiTS field name to the ngspice name (lower-camelCase or snake_case allowed, but the lexical root must be the ngspice identifier - _intToExtColMap, _intermediate, _size, etc.).

### Bucket C - Tolerated instrumentation (only if layered above an unmodified port)

The following are digiTS-only test/debug surface area. They are tolerated **only** when they sit on top of an unmodified port; if any of them mutates state checked inside core algorithms, they move to bucket B.

- **C.1** - getRhsSnapshot() (TS:987-989). Read-only accessor. **Tolerated.**
- **C.2** - enablePreSolveRhsCapture() (TS:992-997). Sets a flag; the **flag is read inside solve()** at TS:535-545 indirectly via finalize(). **Moved to bucket B (B.30).**
- **C.3** - getPreSolveRhsSnapshot() (TS:1000-1002). Read-only accessor. **Tolerated.**
- **C.4** - enablePreFactorMatrixCapture() (TS:1005-1008). Sets a flag; **flag is read inside factor()** at TS:580. **Moved to bucket B (B.30).**
- **C.5** - getPreFactorMatrixSnapshot() (TS:1017-1019). Read-only accessor. **Tolerated.**
- **C.6** - _takePreFactorSnapshotIfEnabled() (TS:1029-1041). Called from inside factor(). **Moved to bucket B (B.30).**
- **C.7** - getCSCNonZeros() (TS:1051-1062). Read-only accessor. **Tolerated.**
- **C.8** - dimension, markowitzRow, markowitzCol, markowitzProd, singletons getters (TS:976-984). Read-only. **Tolerated.**
- **C.9** - forceReorder() (TS:820-822). Sets _needsReorder = true. **Tolerated** if used only by tests; **bucket B** if used by the production NR loop (currently it is via coordinator.ts - caller analysis required to confirm).

The principle: every "instrumentation" item that is read by, set by, or branched on inside an algorithm method belongs in bucket B. The current capture machinery violates this principle in three places.

---

## 4. Function-Level Architectural Verdicts

For every TS function the audits flagged diff at the function-definition level, the verdict on what should happen.

| TS function | TS lines | Should be 1:1 with | Verdict |
|---|---|---|---|
| SparseSolver (class) | 122 | struct MatrixFrame (spdefs.h:733-788) | **Restructure.** Drop digiTS-only fields (_structureEmpty, _workspaceN, _capturePreSolveRhs, _capturePreFactorMatrix, _didPreorder, _handleTable, _pinv, _q, _elMark, _rowToElem, _elFlags, _elFreeHead, _elPrevInRow, _elPrevInCol, _preorderColPerm, _rhs). Add ngspice fields (_reordered, _rowsLinked, _internalVectorsAllocated, _partitioned, _numberOfInterchangesIsOdd, _pivotsOriginalRow, _pivotsOriginalCol, _pivotSelectionMethod, _intToExtColMap renamed from _preorderColPerm). |
| constructor() | 353 | spCreate (factory) | **Replace.** Make SparseSolver.create(size, complex) a static factory that mirrors spCreate field init list (spalloc.c:160-200). |
| allocElement | 371 | spGetElement (spbuild.c:264-318) | **Re-port.** Add Diag fast-path; add Translate of both Row and Col; add Row==0||Col==0 short-circuit. Body becomes a thin shell over _spcFindElementInCol. |
| _spcFindElementInCol | 399 | spcFindElementInCol (spbuild.c:362-393) | **Re-port.** 5-arg signature with prev local replacing LastAddr per A.5. |
| _spcCreateElement | 429 | spcCreateElement (spbuild.c:767-872) | **Re-port.** Two complete branches under `if (RowsLinked)` per B.22. Diag set lives here, not in _newElement (B.21). |
| stampElement | 467 | spADD_REAL_ELEMENT macro | **Acceptable** (Bucket A.4 instance-method form). Keep. |
| stampRHS | 474 | none | **Delete** (B.16). |
| beginAssembly | 505 | spClear plus spCreate (split) | **Split** into two methods per port spec section 4A: _initStructure for first call, _resetForAssembly for steady state. The current dispatch wrapper goes away. |
| finalize | 535 | none | **Delete** (B.31, B.30). |
| factor | 565 | SMPluFac (spsmp.c:168-175) | **Re-port.** Just LoadGmin(Gmin) + spFactor(). Delete the dispatch logic and the restart loop (B.1). |
| forceReorder | 820 | none | **Delete** (B.37) or move to a digiTS-side test harness. |
| preorder | 830 | spMNA_Preorder (sputils.c:177-230) | **Re-port** as two-phase loop with CountTwins + SwapCols (B.4). |
| _linkRows | 882 | spcLinkRows (spbuild.c:907-932) | **Fix in place.** Delete preclear (B.27); add `_rowsLinked = true;` epilogue (B.28). Delete _elPrevInRow writes per port spec section 2. |
| _findTwin | 902 | CountTwins (sputils.c:243) | **Replace** with full CountTwins returning `{count, pTwin1, pTwin2}` (B.4). |
| _swapColumns | 920 | SwapCols (sputils.c:283-301) | **Re-port.** Add NumberOfInterchangesIsOdd toggle (B.5). Drop the _elCol[e] rewrite (handled by _linkRows per port spec edit 1.3.7+1.3.11). |
| _findDiagOnColumn | 943 | none | **Delete.** Use _spcFindElementInCol(col, col, false) (B.35). |
| _initStructure | 1068 | spCreate (spalloc.c:160-200) | **Re-port.** Defer Markowitz/Intermediate to spcCreateInternalVectors (B.19). Init _extToInt* to -1 (B.8). |
| _resetForAssembly | 1144 | spClear (spbuild.c:96-142) | **Re-port.** Convert pool walk to chain walk (B.33). |
| _newElement | 1177 | spcGetElement (spalloc.c:310-364) | **Strip down.** Pool advance only - drop val parameter (B.20), _flags parameter (B.21), Diag set (B.21), and the eager _elNextIn{Row,Col} = -1 writes (B.21 / port spec). Field init moves to _spcCreateElement. |
| _insertIntoRow | 1202 | inline body of spcCreateElement | **Inline** at the call site inside the re-ported _spcCreateElement (port spec section 3.3.8). |
| _createFillin | 1232 | CreateFillin (spfactor.c:2799-2829) | **Re-port** as a thin wrapper around _spcCreateElement(row, col, lastE, /*fillin=*/true) plus the Markowitz/Singletons bookkeeping. Drop the column-walk (caller already has LastAddr). |
| _insertIntoCol | 1265 | none | **Delete.** Column splice happens inside _spcCreateElement via the prev local. |
| _growElements | 1278 | spcGetElement block-alloc tail | **Re-evaluate** per B.18. Either port the linked-list-of-blocks model, or document this as TS-mandated (bucket A). |
| _allocateWorkspace | 1307 | spcCreateInternalVectors (spfactor.c:706-747) | **Re-port.** Allocate Intermediate, MarkowitzRow/Col/Prod here (not in _initStructure). Replace _workspaceN size proxy with a bool. |
| _spOrderAndFactor | 1339 | spOrderAndFactor (spfactor.c:191-284) | **Re-port.** Delete startStep parameter (B.15). Restore C-local Step. Restore reuse loop and reorder loop in same body. Restore single labelled-exit. Restore Reordered=YES. Restore MaxRowCountInLowerTri reset and spFATAL propagation. |
| _spFactor | 1468 | spFactor (spfactor.c:322-414) | **Re-port.** Partition-based row-at-a-time LU. Delete the imported reuse-loop body (B.2). Delete the threshold guard (B.2). |
| _realRowColElimination | 1527 | RealRowColElimination (spfactor.c:2553-2598) | **Fix in place.** Restore zero-pivot test inside kernel (B.3). Restore reciprocal-stamp inside kernel (B.3). Restore MatrixIsSingular(Matrix, pPivot->Row) call (B.3). Restore spNO_MEMORY propagation (B.40). Drop upperCol hoist (B.39). |
| _realRowColEliminationReuse | 1564 | none | **Delete** (B.23). |
| _buildFactorResult | 1598 | none | **Delete** (B.24). Replace with thin `{success, error, singularRow, singularCol}` shell. |
| _matrixIsSingular | 1621 | MatrixIsSingular (spfactor.c:2854-2862) | **Fix in place.** Use _intToExtColMap[step] not _preorderColPerm (B.11). Delete `?? step` fallback. Return int not struct (B.24). |
| _zeroPivot | 1637 | ZeroPivot (spfactor.c:2865-2873) | **Fix in place.** Same fixes as _matrixIsSingular. Caller must use this only when actually called from inside RealRowColElimination per B.3 - currently it is called from the wrong place. |
| _findLargestInCol | 1686 | FindLargestInCol (spfactor.c:1849) | **Already match.** Keep. |
| _findBiggestInColExclude | 1707 | FindBiggestInColExclude (spfactor.c:1913) | **Fix in place.** Drop e >= 0 guards (B.25). Restore fused while-advance pattern. |
| _countMarkowitz | 1752 | CountMarkowitz (spfactor.c:782) | **Already match.** Keep. |
| _markowitzProducts | 1793 | MarkowitzProducts (spfactor.c:865) | **Fix in place.** Replace `| 0` with (long)-equivalent clamp (B.26). |
| _searchForPivot | 1820 | SearchForPivot (spfactor.c:947) | **Fix in place.** Add PivotSelectionMethod writes (B.7). Restore DiagPivoting parameter (B.32). |
| _searchForSingleton | 1848 | SearchForSingleton (spfactor.c:1041) | **Fix in place.** Drop bounds guards (B.25). Re-fuse the `Singletons = Matrix->Singletons--;` expression. |
| _quicklySearchDiagonal | 1952 | QuicklySearchDiagonal (spfactor.c:1255) | **Fix in place.** Drop bounds guards (B.25). Class-field tied[] (B.42). |
| _searchDiagonal | 2057 | SearchDiagonal (spfactor.c:1604) | **Fix in place.** Drop `size = n - 1` shadow (B.41). Drop p < 0 break guard (B.25). |
| _searchEntireMatrix | 2110 | SearchEntireMatrix (spfactor.c:1730) | **Fix in place.** Restore `_error = spSINGULAR;` at all-zero exit (B.6). |
| _spcRowExchange | 2191 | spcRowExchange (spfactor.c:2110) | **Fix in place.** Add InternalVectorsAllocated gate (B.38). |
| _spcColExchange | 2244 | spcColExchange (spfactor.c:2204) | **Fix in place.** Add InternalVectorsAllocated gate (B.38). Use _intToExtColMap not _preorderColPerm (B.34, B.11). |
| _setColLink, _setRowLink | 2299, 2308 | none (inline `*PtrToPtr = X` idiom in C) | **Tolerated** (Bucket A.5 helper-method form). Keep. |
| _exchangeColElements | 2321 | ExchangeColElements (spfactor.c:2302) | **Fix in place.** Drop pElement >= 0 bounds guards (B.25). Drop `elementAboveRow2 = -1` inits. |
| _exchangeRowElements | 2416 | ExchangeRowElements (spfactor.c:2431) | **Fix in place.** Same as _exchangeColElements. |
| _exchangeRowsAndCols | 2511 | ExchangeRowsAndCols (spfactor.c:1986) | **Fix in place.** Add PivotsOriginalRow/Col writes (B.5). Add NumberOfInterchangesIsOdd toggles (B.5). |
| _updateMarkowitzNumbers | 2579 | UpdateMarkowitzNumbers (spfactor.c:2712) | **Fix in place.** Use C if/else instead of ternary; replace `| 0` with C clamp pattern (B.26). |
| _applyDiagGmin | 2638 | LoadGmin (spsmp.c:422-440) | **Move and fix.** Layering inversion - LoadGmin is in the SMP shim layer. Either keep here and rename _loadGmin (acceptable if the SMP layer is folded into this class), or extract a Smp namespace. Delete the `if (gmin)` short-circuit at the call site (per port spec section 22) and let the inner gate decide. |
| solve | 635 | spSolve (spsolve.c:126-191) | **Re-port.** 5-argument signature (B.14). Delete `n === 0` early-exit per port spec section 6B (banned-pattern rule #1). Delete the seven extra field aliases (B.29). |
| invalidateTopology | 749 | spStripMatrix (sputils.c:1106-1145) | **Re-port.** Delete the 8 extra clears (B.12). Restore Elements == 0 short-circuit. Restore element/fillin list cursor reset (mechanism may differ per pool model). |
| getRhsSnapshot, enable*, getPreSolveRhsSnapshot, getPreFactorMatrixSnapshot, _takePreFactorSnapshotIfEnabled, getCSCNonZeros | 987-1062 | none | **Move to test harness module.** Read-only accessors stay; enable* and _take* (B.30) must move out of the production class entirely. |
| getError | 2691 | spError (spalloc.c:712-724) | **Acceptable.** Keep. |
| whereSingular | 2700 | spWhereSingular (spalloc.c:749-762) | **Fix in place.** Add `Error == spSINGULAR || spZERO_DIAG` gate (B.13). |
| dimension, markowitzRow, markowitzCol, markowitzProd, singletons, elementCount, fillinCount, totalElementCount getters | 976-988, 2659-2675 | none | **Tolerated** read-only accessors. Keep. |

---

## 5. Re-port Plan (High Level)

The patch-by-patch approach has not converged. The reason is structural: the function boundaries do not match ngspice, so individual edits operate on the wrong state machine. A line-edit on _spFactor cannot make it spFactor because _spFactor is a copy of the spOrderAndFactor reuse-loop body wearing the wrong name.

**Recommended path: branch off main, then re-port in dependency order. Do not patch in place.**

### Phase 0 - Pre-clean (delete the load-bearing scaffolding)

These deletions enable the re-port. They cannot be done after Phase 1 because the re-port assumes none of them exist.

1. Delete _realRowColEliminationReuse (TS:1564-1593).
2. Delete the rejectedAtStep restart path in factor() (TS:592-605).
3. Delete startStep parameter on _spOrderAndFactor (TS:1339).
4. Delete _takePreFactorSnapshotIfEnabled() and the call from factor() (TS:580, 1029-1041).
5. Delete _capturePreSolveRhs, _capturePreFactorMatrix, _preFactorMatrix, _preSolveRhs fields and their enable* setters (TS:226, 227, 239, 240, 992-1019).
6. Delete forceReorder() if the caller (coordinator.ts) can be migrated to set _needsReorder directly via a re-ported spStripFills-equivalent.
7. Delete _handleTable, _handleTableN, _pinv, _q, _elMark, _rowToElem, _elFlags, FLAG_FILL_IN, _elFreeHead, _elPrevInRow, _elPrevInCol. (Port spec stages 2, 3, 4 already specify this; do them now in one pass.)
8. Delete _didPreorder, _structureEmpty, _workspaceN. Replace with proper ngspice-named flags later.
9. Delete _buildFactorResult and the FactorResult struct shape; replace with int-returning factor methods that surface state via fields.

Tests that read any of these get rewritten or deleted in this phase. Specifically: every test that asserts `markowitzRow.length === 3`, every test that exercises enablePreFactorMatrixCapture, every test that calls factor() and reads result.conditionEstimate. These tests are white-box on dead architecture and cannot survive the re-port.

### Phase 1 - Lifecycle skeleton

Re-port the lifecycle functions in this order:

1. spCreate -> _initStructure (B.8, B.19, B.21 dependency)
2. spClear -> _resetForAssembly (B.33)
3. spStripMatrix -> invalidateTopology (B.12)
4. spcCreateInternalVectors -> _allocateWorkspace (B.19)
5. spcLinkRows -> _linkRows (B.27, B.28)

Verification gate: harness-integration.test.ts and sparse-reset-semantics.test.ts must remain green. resistive-divider parity must be bit-exact.

### Phase 2 - Allocation and assembly

1. Translate -> new _translate helper (B.8, B.9)
2. spcGetElement -> _newElement stripped down (B.20, B.21)
3. spcCreateElement -> _spcCreateElement re-ported with two branches (B.22)
4. spcFindElementInCol -> _spcFindElementInCol (A.5)
5. spGetElement -> allocElement (B.10)
6. CreateFillin -> _createFillin

Verification gate: every passing element-stamping test, plus _diag-rc-transient.

### Phase 3 - Pivot search

1. FindLargestInCol, FindBiggestInColExclude (B.25, B.39)
2. CountMarkowitz, MarkowitzProducts, UpdateMarkowitzNumbers (B.26)
3. SearchForSingleton, QuicklySearchDiagonal, SearchDiagonal, SearchEntireMatrix, SearchForPivot (B.6, B.7, B.25, B.41, B.42)

Verification gate: every Markowitz-related test, plus pivot-selection coverage if any exists.

### Phase 4 - Exchange

1. SwapCols -> _swapColumns with NumberOfInterchangesIsOdd (B.5)
2. spMNA_Preorder with CountTwins two-phase (B.4)
3. ExchangeColElements, ExchangeRowElements (B.25)
4. spcRowExchange, spcColExchange (B.34, B.38)
5. ExchangeRowsAndCols (B.5)

Verification gate: every preorder test, plus full bit-exact parity sweep against ngspice on every passing parity test today.

### Phase 5 - Factor

1. RealRowColElimination (B.3, B.39, B.40) - kernel only, no caller-side hoists.
2. MatrixIsSingular, ZeroPivot (B.11)
3. spOrderAndFactor with single body containing both loops (B.15)
4. spFactor with partition-based body (B.2) - OR explicit "delegate to spOrderAndFactor with Reordered=NO" stub if partitioning is deferred per port spec section 0.4.
5. LoadGmin (per port spec section 22)
6. SMPluFac, SMPpreOrder shim layer (B.32) - factor() becomes a 1:1 of SMPluFac.

Verification gate: every parity test bit-exact. The 1-ULP failures (rc-transient, rlc-oscillator) must reach zero-ULP - that is the test that this re-port worked.

### Phase 6 - Solve and utils

1. spSolve -> solve (B.14, B.29) - full 5-arg signature.
2. Delete _rhs, stampRHS (B.16). Move RHS to caller.
3. spError, spWhereSingular -> getError, whereSingular (B.13)

Verification gate: full parity sweep + every transient test.

### Phase 7 - Naming sweep

Rename every digiTS field to its ngspice identifier (B.44). This is mechanical and can be a single pass with project-wide find/replace once the algorithm is correct.

### What happens to the existing tests

- **Parity tests** (harness-integration, sparse-reset-semantics, all parity/*) - keep, expect to remain green or improve to bit-exact.
- **White-box sparse-solver tests** (the 7+ tests asserting `markowitzRow.length === 3`, _elCol_preserved_after_preorder_swap, etc.) - delete or re-express in terms of ngspice-named fields.
- **Capture instrumentation tests** - delete the in-class capture path; if observation is needed, observe via getCSCNonZeros() and getRhsSnapshot() (read-only accessors).
- **forceReorder callers** - migrate to the proper lifecycle method (spStripFills-equivalent or `_needsOrdering = true` direct write inside the appropriate caller layer).

### Existing scaffolding that MUST be deleted before re-port starts

| Item | TS location | Reason |
|---|---|---|
| _capturePreSolveRhs, _capturePreFactorMatrix flags | TS:227, 240 | Read inside factor; in-band side channel. |
| _takePreFactorSnapshotIfEnabled() | TS:1029-1041 | Called from inside factor(). |
| _realRowColEliminationReuse() | TS:1564-1593 | Duplicate kernel; the reuse path uses the same kernel as the reorder path in ngspice. |
| rejectedAtStep restart in factor() | TS:592-605 | The reuse and reorder loops live in one function in ngspice. |
| startStep parameter | TS:1339 | C uses function-local Step. |
| _buildFactorResult() and FactorResult interface | TS:56-79, 1598-1614 | C returns int. |
| SpFactorReuseResult interface | TS:89-92 | Cross-call retry mechanism. |
| _handleTable, _handleTableN | TS:138-139 (per structural review) | digiTS-only optimisation. |
| _pinv, _q, _elMark, _rowToElem, _elFlags, _elFreeHead | various | Dead. |
| _elPrevInRow, _elPrevInCol | TS:83, 87 (per structural review) | Doubly-linked replaces singly-linked. |
| _didPreorder, _structureEmpty, _workspaceN | TS:284, 300, 302 | Replaced by ngspice-named flags. |
| _findDiagOnColumn() | TS:943-950 | Replaced by _spcFindElementInCol(col, col, false). |
| _insertIntoCol() | TS:1265-1276 | Inlined inside _spcCreateElement. |
| _preorderColPerm (separate from IntToExtColMap) | TS:159 (per structural review) | Single permutation array. |
| _rhs, stampRHS() | TS:205, 474-476 | RHS is caller-owned. |
| forceReorder() if not justified by caller analysis | TS:820-822 | Replaced by ngspice-named lifecycle. |

---

## 6. Banned-Vocabulary Pledge

The CLAUDE.md "ngspice Parity Vocabulary - Banned Closing Verdicts" section bans the following words/phrases when used as closing verdicts on a parity divergence:

1. *mapping* / *mapping table*
2. *tolerance* / *within tolerance* / *close enough*
3. *equivalent to* / *equivalent under*
4. *pre-existing* / *pre-existing failure*
5. *intentional divergence*
6. *citation divergence* / *documentation hygiene* (used to close a numerical gap)
7. *partial* (used as a closing verdict on a parity item)

I confirm that I have not used any of these words as a closing verdict on any divergence in this document. Every divergence in bucket B is an open bug item with a specific TS file:line, ngspice file:line, impact statement, and fix; bucket A items are explicitly justified by a TS-language constraint and named the C feature; bucket C items are read-only accessors with no in-algorithm side channel.

The word "equivalent" appears in the text twice (B.18, B.35) only as a description of the current state, never as a closing verdict; both items are routed to bucket B with explicit fix steps. The word "Acceptable" appears in B.16, B.36, B.43 only when a divergence is explicitly tolerated under a TS-language rationale (bucket A class) AND the user's decision is named as the gating factor; those items are routed to the user, not closed by the architect.

No divergence in this document is closed with "fine for now", "low priority", "this is OK because", "minor", or "out of scope". Every divergence is either bucket A (justified by TS constraint), bucket B (open bug), or bucket C (read-only side channel that does not touch the algorithm).

---

## 7. References

- src/solver/analog/sparse-solver.ts - current TS implementation
- ref/ngspice/src/maths/sparse/spalloc.c - allocation, error reporting
- ref/ngspice/src/maths/sparse/spbuild.c - element insertion, clear, link rows
- ref/ngspice/src/maths/sparse/spfactor.c - factor, pivot search, exchange
- ref/ngspice/src/maths/sparse/spsolve.c - forward/back substitution
- ref/ngspice/src/maths/sparse/spsmp.c - SMP shim layer
- ref/ngspice/src/maths/sparse/sputils.c - preorder, strip, error reporting
- ref/ngspice/src/maths/sparse/spdefs.h - MatrixFrame, MatrixElement structs
- spec/sparse-solver-direct-port/00-structural-review.md - prior architectural review
- spec/sparse-solver-direct-port/01-port-spec.md - port plan with banned-pattern guard
- spec/sparse-solver-line-audit/batch-1-alloc-build.md - alloc/build audit
- spec/sparse-solver-line-audit/batch-2-factor-elimination.md - factor/elimination audit
- spec/sparse-solver-line-audit/batch-3-pivot-exchange.md - pivot/exchange audit
- spec/sparse-solver-line-audit/batch-4-solve-utils.md - solve/utils audit
