# Rename map — VCCS (`vccs/`)

ngspice identifier → digiTS identifier, for `src/components/active/vccs.ts`
(`VCCSAnalogElement`). Documentation only; the verifier re-derives equivalence
independently (TASK.md §7).

## Instance matrix-element handles (`sVCCSinstance`, `vccsdefs.h`)

| ngspice (v41) | ngspice (v26) | digiTS | Notes |
|---|---|---|---|
| `VCCSposContPosPtr` | `VCCSposContPosptr` | `_hPCtP` | G[posNode, ctrlPosNode] handle |
| `VCCSposContNegPtr` | `VCCSposContNegptr` | `_hPCtN` | G[posNode, ctrlNegNode] handle |
| `VCCSnegContPosPtr` | `VCCSnegContPosptr` | `_hNCtP` | G[negNode, ctrlPosNode] handle |
| `VCCSnegContNegPtr` | `VCCSnegContNegptr` | `_hNCtN` | G[negNode, ctrlNegNode] handle |

The v26→v41 delta on these four fields is the `ptr`→`Ptr` capitalisation rename
(an allowed identifier-rename difference). digiTS already names them `_hPCtP`
etc., so the rename renders as a zero-line TS delta.

## Node ids

| ngspice | digiTS | Notes |
|---|---|---|
| `VCCSposNode` | `this.pinNodes.get("out+")` | source positive node |
| `VCCSnegNode` | `this.pinNodes.get("out-")` | source negative node |
| `VCCScontPosNode` | `this.pinNodes.get("ctrl+")` | control positive node |
| `VCCScontNegNode` | `this.pinNodes.get("ctrl-")` | control negative node |

## Coefficient / multiplier

| ngspice | digiTS | Notes |
|---|---|---|
| `VCCScoeff` | `gm` (stamp `derivative`) / `effectiveGm` | transconductance fed to the stamp |
| `VCCSmValue` | `M` model param (`VCCS_PARAM_DEFS`) | parallel multiplier (reconstruction `vccs#recon/multiplierAndIc`) |

## Function / loop-walk correspondence (load / setup)

| ngspice | digiTS | Notes |
|---|---|---|
| `VCCSload` (loop body) | `VCCSAnalogElement.stampOutput` | per-instance load body; engine drives the model/instance walk |
| `VCCSsetup` (loop body) | `VCCSAnalogElement.setup` | per-instance TSTALLOC body |
| `model->VCCSnextModel` → `VCCSnextModel(model)` | engine walk | C↔TS: the model linked-list walk has no per-element landing |
| `here->VCCSnextInstance` → `VCCSnextInstance(here)` | engine walk | C↔TS: the instance linked-list walk has no per-element landing |
| `model->VCCSinstances` → `VCCSinstances(model)` | engine walk | C↔TS accessor-macro rename |
| `*(ptr) += coeff` | `solver.stampElement(handle, value)` | C↔TS sparse-matrix accumulation |
| `TSTALLOC(ptr, a, b)` | `solver.allocElement(a, b)` | C↔TS sparse-element allocation |
