# Rename map — CCCS (`cccs/`)

ngspice identifier → digiTS identifier, for `src/components/active/cccs.ts`
(`CCCSAnalogElement`). Documentation only; the verifier re-derives equivalence
independently (TASK.md §7).

## Instance matrix-element handles (`sCCCSinstance`, `cccsdefs.h`)

| ngspice (v41) | ngspice (v26) | digiTS | Notes |
|---|---|---|---|
| `CCCSposContBrPtr` | `CCCSposContBrptr` | `_hPCtBr` | G[posNode, contBranch] handle |
| `CCCSnegContBrPtr` | `CCCSnegContBrptr` | `_hNCtBr` | G[negNode, contBranch] handle |

The v26→v41 delta on these two fields is the `ptr`→`Ptr` capitalisation rename
(an allowed identifier-rename difference). digiTS already names them `_hPCtBr`
/ `_hNCtBr`, so the rename renders as a zero-line TS delta. This is the same
shape as the sibling VCVS `…ptr`→`…Ptr` handle renames.

## Node ids

| ngspice (v41) | ngspice (v26) | digiTS | Notes |
|---|---|---|---|
| `const int CCCSposNode` | `int CCCSposNode` | `this.pinNodes.get("out+")` | source positive node; `const` qualifier ↔ `ReadonlyMap` immutability (C↔TS syntax) |
| `const int CCCSnegNode` | `int CCCSnegNode` | `this.pinNodes.get("out-")` | source negative node |
| `CCCScontBranch` | `CCCScontBranch` | `_contBranch` | controlling-branch row index (unchanged v26→v41) |

## Coefficient

| ngspice | digiTS | Notes |
|---|---|---|
| `CCCScoeff` | `derivative` (`gm`) / compiled `f'(I(sense))` | coefficient fed to the control-column stamp |
| `CCCSmValue` | `M` model param | parallel multiplier (folded into `effectiveGain`) |

## Struct-embedding plumbing (no digiTS field counterpart)

The v26→v41 delta replaces the hand-rolled generic-struct prefix with a
`struct GENinstance gen` / `struct GENmodel gen` embedding plus accessor macros.
These are C↔TS structural plumbing with no per-element TS field (the model
backpointer, next-instance/next-model pointers, instance/model name, and state
base are engine-managed in digiTS). The hunk therefore renders as a zero-line
TS delta.

| ngspice (v41 accessor) | ngspice (v26 field) | digiTS | Notes |
|---|---|---|---|
| `CCCSmodPtr(inst)` | `CCCSmodPtr` | engine-managed | model backpointer; no per-element field |
| `CCCSnextInstance(inst)` | `CCCSnextInstance` | engine walk | instance linked-list iterator |
| `CCCSname` (`gen.GENname`) | `CCCSname` | engine-managed | instance name |
| `CCCSstate` (`gen.GENstate`) | `CCCSstate` | engine-managed | state base index |
| `CCCSmodType` (`gen.GENmodType`) | `CCCSmodType` | engine-managed | model type index |
| `CCCSnextModel(inst)` | `CCCSnextModel` | engine walk | model linked-list iterator |
| `CCCSinstances(inst)` | `CCCSinstances` | engine walk | model→instances list head |
| `CCCSmodName` (`gen.GENmodName`) | `CCCSmodName` | engine-managed | model name |

## Function / loop-walk correspondence (load / setup)

| ngspice | digiTS | Notes |
|---|---|---|
| `CCCSload` (loop body) | `CCCSAnalogElement.stampOutput` (via `load()`) | per-instance load body; engine drives the model/instance walk |
| `CCCSsetup` (loop body) | `CCCSAnalogElement.setup` | per-instance branch-resolve + TSTALLOC body |
| `model->CCCSnextModel` → `CCCSnextModel(model)` | engine walk | C↔TS: model linked-list walk has no per-element landing |
| `here->CCCSnextInstance` → `CCCSnextInstance(here)` | engine walk | C↔TS: instance linked-list walk has no per-element landing |
| `model->CCCSinstances` → `CCCSinstances(model)` | engine walk | C↔TS accessor-macro rename |
| `*(here->CCCSposContBrPtr) += here->CCCScoeff` | `solver.stampElement(_hPCtBr, gm)` | C↔TS sparse-matrix accumulation (`+= CCCScoeff` unchanged v26→v41) |
| `*(here->CCCSnegContBrPtr) -= here->CCCScoeff` | `solver.stampElement(_hNCtBr, -gm)` | C↔TS sparse-matrix accumulation (`-= CCCScoeff` unchanged v26→v41) |
| `here->CCCScontBranch = CKTfndBranch(ckt, here->CCCScontName)` | `ctx.findBranch(this._senseSourceLabel)` | C↔TS branch resolve (context line; unchanged in the v26→v41 delta) |
| `if(here->CCCScontBranch == 0){ IFerrorf(ERR_FATAL,…); return(E_BADPARM); }` | `if (contBranch === 0) throw new Error(…)` | C↔TS fatal-stop (context line; unchanged) |
| `TSTALLOC(CCCSposContBrPtr, CCCSposNode, CCCScontBranch)` | `solver.allocElement(posNode, contBranch)` | C↔TS sparse-element allocation (`ptr`→`Ptr` field rename) |
| `TSTALLOC(CCCSnegContBrPtr, CCCSnegNode, CCCScontBranch)` | `solver.allocElement(negNode, contBranch)` | C↔TS sparse-element allocation (`ptr`→`Ptr` field rename) |
