# Rename map — VCVS (`vcvs/`)

ngspice identifier → digiTS identifier, for `src/components/active/vcvs.ts`
(`VCVSAnalogElement`). Documentation only; the verifier re-derives equivalence
independently (TASK.md §7).

## Instance matrix-element handles (`sVCVSinstance`, `vcvsdefs.h`)

| ngspice (v41) | ngspice (v26) | digiTS | Notes |
|---|---|---|---|
| `VCVSposIbrPtr` | `VCVSposIbrptr` | `_hPIbr` | B[posNode, branch] handle |
| `VCVSnegIbrPtr` | `VCVSnegIbrptr` | `_hNIbr` | B[negNode, branch] handle |
| `VCVSibrPosPtr` | `VCVSibrPosptr` | `_hIbrP` | C[branch, posNode] handle |
| `VCVSibrNegPtr` | `VCVSibrNegptr` | `_hIbrN` | C[branch, negNode] handle |
| `VCVSibrContPosPtr` | `VCVSibrContPosptr` | `_hIbrCtP` | C[branch, ctrlPosNode] handle |
| `VCVSibrContNegPtr` | `VCVSibrContNegptr` | `_hIbrCtN` | C[branch, ctrlNegNode] handle |

The v26→v41 delta on these six fields is the `ptr`→`Ptr` capitalisation rename
(an allowed identifier-rename difference). digiTS already names them `_hPIbr`
etc., so the rename renders as a zero-line TS delta.

## Node ids

| ngspice (v41) | ngspice (v26) | digiTS | Notes |
|---|---|---|---|
| `const int VCVSposNode` | `int VCVSposNode` | `this.pinNodes.get("out+")` | source positive node; `const` qualifier ↔ `ReadonlyMap` immutability (C↔TS syntax) |
| `const int VCVSnegNode` | `int VCVSnegNode` | `this.pinNodes.get("out-")` | source negative node |
| `const int VCVScontPosNode` | `int VCVScontPosNode` | `this.pinNodes.get("ctrl+")` | control positive node |
| `const int VCVScontNegNode` | `int VCVScontNegNode` | `this.pinNodes.get("ctrl-")` | control negative node |
| `VCVSbranch` | `VCVSbranch` | `this.branchIndex` | branch equation row index (unchanged v26→v41) |

## Runtime validation (degenerate topology)

| ngspice (v41) | digiTS | Notes |
|---|---|---|
| `if(VCVSposNode == VCVSnegNode){ IFerrorf(ERR_FATAL,"instance %s is a shorted VCVS",VCVSname); return(E_UNSUPP); }` (`vcvsset.c:35-39`) | `if (posNode === negNode) throw new Error(\`instance ${label} is a shorted VCVS\`)` (`vcvs.ts` setup) | `IFerrorf(ERR_FATAL) + return(E_UNSUPP)` ↔ thrown Error (the digiTS fatal stop); v41 message wording preserved. Same precedent as `mutual-inductor.ts` porting `mutsetup.c` ERR_FATAL early-returns. |

## Coefficient

| ngspice | digiTS | Notes |
|---|---|---|
| `VCVScoeff` | `_gain` (stamp `derivative`) / compiled `f'(Vctrl)` | gain fed to the control-column stamp |

## Struct-embedding plumbing (no digiTS field counterpart)

The v26→v41 delta replaces the hand-rolled generic-struct prefix with a
`struct GENinstance gen` / `struct GENmodel gen` embedding plus accessor macros.
These are C↔TS structural plumbing with no per-element TS field (the model
backpointer, next-instance/next-model pointers, instance/model name, and state
base are engine-managed in digiTS). The hunk therefore renders as a zero-line
TS delta.

| ngspice (v41 accessor) | ngspice (v26 field) | digiTS | Notes |
|---|---|---|---|
| `VCVSmodPtr(inst)` | `VCVSmodPtr` | engine-managed | model backpointer; no per-element field |
| `VCVSnextInstance(inst)` | `VCVSnextInstance` | engine walk | instance linked-list iterator |
| `VCVSname` (`gen.GENname`) | `VCVSname` | engine-managed | instance name |
| `VCVSstates` (`gen.GENstate`) | `VCVSstates` | engine-managed | state base index |
| `VCVSmodType` (`gen.GENmodType`) | `VCVSmodType` | engine-managed | model type index |
| `VCVSnextModel(inst)` | `VCVSnextModel` | engine walk | model linked-list iterator |
| `VCVSinstances(inst)` | `VCVSinstances` | engine walk | model→instances list head |
| `VCVSmodName` (`gen.GENmodName`) | `VCVSmodName` | engine-managed | model name |

## Device-param / device-question index constants

The v26→v41 delta reformats the `#define` index constants into `enum` blocks
with byte-identical values (`VCVS_GAIN = 1` … `VCVS_VOLTS = 12`;
`VCVS_QUEST_SENS_REAL = 201` … `VCVS_QUEST_SENS_DC = 206`). These are C
param/question dispatch indices with no digiTS counterpart (param access is by
key string). C↔TS syntax / no behavioral content → zero-line TS delta.

## Function / loop-walk correspondence (findBr / load / setup)

| ngspice | digiTS | Notes |
|---|---|---|
| `VCVSfindBr` (idempotent makeCur body) | `ControlledSourceElement.findBranchFor` | inherited by `VCVSAnalogElement`; engine drives the model/instance walk |
| `VCVSload` (loop body) | `VCVSAnalogElement._stampLinear` + `stampOutput` | per-instance load body; engine drives the model/instance walk |
| `VCVSsetup` (loop body) | `VCVSAnalogElement.setup` | per-instance TSTALLOC body |
| `model->VCVSnextModel` → `VCVSnextModel(model)` | engine walk | C↔TS: model linked-list walk has no per-element landing |
| `here->VCVSnextInstance` → `VCVSnextInstance(here)` | engine walk | C↔TS: instance linked-list walk has no per-element landing |
| `model->VCVSinstances` → `VCVSinstances(model)` | engine walk | C↔TS accessor-macro rename |
| `*(here->ptr) += 1.0 / -= 1.0` | `solver.stampElement(handle, ±1)` | C↔TS sparse-matrix accumulation |
| `*(here->ibrContPosPtr) -= coeff` / `ibrContNegPtr += coeff` | `solver.stampElement(_hIbrCtP, -deriv)` / `(_hIbrCtN, +deriv)` | C↔TS control-column accumulation |
| `TSTALLOC(ptr, a, b)` | `solver.allocElement(a, b)` | C↔TS sparse-element allocation |
