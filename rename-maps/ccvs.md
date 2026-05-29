# Rename map — CCVS (`ccvs/`)

ngspice identifier → digiTS identifier, for `src/components/active/ccvs.ts`
(`CCVSAnalogElement`). Documentation only; the verifier re-derives equivalence
independently (TASK.md §7).

(Stub was absent at apply time; authored from the sibling `cccs.md` shape under
the unit's file-scope authorization for `rename-maps/ccvs.md`.)

## Instance matrix-element handles (`sCCVSinstance`, `ccvsdefs.h`)

| ngspice (v41) | ngspice (v26) | digiTS | Notes |
|---|---|---|---|
| `CCVSposIbrPtr` | `CCVSposIbrptr` | `_hPIbr` | G[posNode, branch] handle |
| `CCVSnegIbrPtr` | `CCVSnegIbrptr` | `_hNIbr` | G[negNode, branch] handle |
| `CCVSibrPosPtr` | `CCVSibrPosptr` | `_hIbrP` | G[branch, posNode] handle |
| `CCVSibrNegPtr` | `CCVSibrNegptr` | `_hIbrN` | G[branch, negNode] handle |
| `CCVSibrContBrPtr` | `CCVSibrContBrptr` | `_hIbrCtBr` | G[branch, contBranch] handle |

The v26→v41 delta on these five fields is the `ptr`→`Ptr` capitalisation rename
(an allowed identifier-rename difference). digiTS already names them `_hPIbr` /
`_hNIbr` / `_hIbrP` / `_hIbrN` / `_hIbrCtBr` (ccvs.ts:133-137), so the rename
renders as a zero-line TS delta. Same shape as the sibling CCCS `…ptr`→`…Ptr`
handle renames.

## Node ids

| ngspice (v41) | ngspice (v26) | digiTS | Notes |
|---|---|---|---|
| `const int CCVSposNode` | `int CCVSposNode` | `this.pinNodes.get("out+")` | source positive node; `const` qualifier ↔ `ReadonlyMap` immutability (C↔TS syntax) |
| `const int CCVSnegNode` | `int CCVSnegNode` | `this.pinNodes.get("out-")` | source negative node |
| `CCVSbranch` | `CCVSbranch` | `branchIndex` | own output-VSRC branch row index (unchanged v26→v41) |
| `CCVScontBranch` | `CCVScontBranch` | `_contBranch` | controlling-branch row index (unchanged v26→v41) |

## Coefficient

| ngspice | digiTS | Notes |
|---|---|---|
| `CCVScoeff` | `derivative` (`rm`) / compiled `f'(I(sense))` | coefficient fed to the control-column stamp (`-= CCVScoeff` ↔ `stampElement(_hIbrCtBr, -rm)`) |

## Struct-embedding plumbing (no digiTS field counterpart)

The v26→v41 delta replaces the hand-rolled generic-struct prefix with a
`struct GENinstance gen` / `struct GENmodel gen` embedding plus accessor macros.
These are C↔TS structural plumbing with no per-element TS field (the model
backpointer, next-instance/next-model pointers, instance/model name, and state
base are engine-managed in digiTS). The hunk therefore renders as a zero-line
TS delta.

| ngspice (v41 accessor) | ngspice (v26 field) | digiTS | Notes |
|---|---|---|---|
| `CCVSmodPtr(inst)` | `CCVSmodPtr` | engine-managed | model backpointer; no per-element field |
| `CCVSnextInstance(inst)` | `CCVSnextInstance` | engine walk | instance linked-list iterator |
| `CCVSname` (`gen.GENname`) | `CCVSname` | engine-managed | instance name |
| `CCVSstate` (`gen.GENstate`) | `CCVSstate` | engine-managed | state base index |
| `CCVSmodType` (`gen.GENmodType`) | `CCVSmodType` | engine-managed | model type index |
| `CCVSnextModel(inst)` | `CCVSnextModel` | engine walk | model linked-list iterator |
| `CCVSinstances(inst)` | `CCVSinstances` | engine walk | model→instances list head |
| `CCVSmodName` (`gen.GENmodName`) | `CCVSmodName` | engine-managed | model name |

## Function / loop-walk correspondence (findBr / load / setup)

| ngspice | digiTS | Notes |
|---|---|---|
| `CCVSfindBr` (loop body) | `ControlledSourceElement.findBranchFor` (controlled-source-base.ts:136-141) reached via `ctx.findBranch` (ccvs.ts:156) | per-instance branch-resolve; engine drives the model/instance walk |
| `CCVSload` (loop body) | `CCVSAnalogElement._stampLinear` + `stampOutput` (via `load()`) | per-instance load body; engine drives the model/instance walk |
| `CCVSsetup` (loop body) | `CCVSAnalogElement.setup` | per-instance shorted-check + branch-resolve + TSTALLOC body |
| `model->CCVSnextModel` → `CCVSnextModel(model)` | engine walk | C↔TS: model linked-list walk has no per-element landing |
| `here->CCVSnextInstance` → `CCVSnextInstance(here)` | engine walk | C↔TS: instance linked-list walk has no per-element landing |
| `model->CCVSinstances` → `CCVSinstances(model)` | engine walk | C↔TS accessor-macro rename |
| `if(here->CCVSname == name)` / `if(here->CCVSbranch == 0)` / `CKTmkCur` / `return(here->CCVSbranch)` | `findBranchFor` idempotent `makeCur` guard | findBr body unchanged v26→v41 (context) |
| `*(here->CCVSposIbrPtr) += 1.0` | `solver.stampElement(_hPIbr, 1)` | C↔TS sparse accumulation (`+= 1.0` unchanged v26→v41) |
| `*(here->CCVSnegIbrPtr) -= 1.0` | `solver.stampElement(_hNIbr, -1)` | C↔TS sparse accumulation (`-= 1.0` unchanged) |
| `*(here->CCVSibrPosPtr) += 1.0` | `solver.stampElement(_hIbrP, 1)` | C↔TS sparse accumulation (`+= 1.0` unchanged) |
| `*(here->CCVSibrNegPtr) -= 1.0` | `solver.stampElement(_hIbrN, -1)` | C↔TS sparse accumulation (`-= 1.0` unchanged) |
| `*(here->CCVSibrContBrPtr) -= here->CCVScoeff` | `solver.stampElement(_hIbrCtBr, -rm)` | C↔TS sparse accumulation (`-= CCVScoeff` unchanged; `ptr`→`Ptr` field rename) |
| `if(here->CCVSposNode == here->CCVSnegNode){ IFerrorf(ERR_FATAL,…); return(E_UNSUPP); }` | `if (posNode === negNode) throw …` shorted-CCVS fatal | setup context line (unchanged v26→v41) |
| `here->CCVScontBranch = CKTfndBranch(ckt, here->CCVScontName)` | `ctx.findBranch(this._senseSourceLabel)` | C↔TS branch resolve (context line; unchanged) |
| `if(here->CCVScontBranch == 0){ IFerrorf(ERR_FATAL,…); return(E_BADPARM); }` | `if (contBranch === 0) throw …` | C↔TS fatal-stop unknown-control (context line; unchanged) |
| `TSTALLOC(CCVSposIbrPtr, CCVSposNode, CCVSbranch)` | `solver.allocElement(posNode, ownBranch)` | C↔TS sparse-element allocation (`ptr`→`Ptr` field rename) |
| `TSTALLOC(CCVSnegIbrPtr, CCVSnegNode, CCVSbranch)` | `solver.allocElement(negNode, ownBranch)` | C↔TS sparse-element allocation (`ptr`→`Ptr` field rename) |
| `TSTALLOC(CCVSibrNegPtr, CCVSbranch, CCVSnegNode)` | `solver.allocElement(ownBranch, negNode)` | C↔TS sparse-element allocation (`ptr`→`Ptr` field rename) |
| `TSTALLOC(CCVSibrPosPtr, CCVSbranch, CCVSposNode)` | `solver.allocElement(ownBranch, posNode)` | C↔TS sparse-element allocation (`ptr`→`Ptr` field rename) |
| `TSTALLOC(CCVSibrContBrPtr, CCVSbranch, CCVScontBranch)` | `solver.allocElement(ownBranch, contBranch)` | C↔TS sparse-element allocation (`ptr`→`Ptr` field rename) |
