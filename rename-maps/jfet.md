# Rename map — jfet (NJFET)

ngspice identifier → digiTS identifier, for the v41 port of the JFET device
(`src/components/semiconductors/njfet.ts`). Documentation only; the verifier
re-derives equivalence independently and does not consume this file.

## Model / instance linked-list walk (no digiTS counterpart)

The C model/instance linked-list walk has no per-element counterpart in digiTS
(the engine invokes each element object directly). These accessor-macro renames
are sec4-allowed iteration plumbing and render as a zero-line TS delta.

| ngspice | digiTS |
|---|---|
| `model = model->JFETnextModel` / `JFETnextModel(model)` | (none — per-element invocation) |
| `here = model->JFETinstances` / `JFETinstances(model)` | (none — per-element invocation) |
| `here = here->JFETnextInstance` / `JFETnextInstance(here)` | (none — per-element invocation) |

## State vector

| ngspice | digiTS |
|---|---|
| `JFETnumStates` (= 13) | `JFET_SCHEMA.size` (= 13), used via `this.stateSize` |
| `*states += JFETnumStates` | `ctx.allocStates(this.stateSize)` |

## Model temperature/bandgap parameters (jfettemp.c::JFETtemp)

| ngspice | digiTS |
|---|---|
| `model->JFETeg`        | `p.EG` |
| `model->JFETxti`       | `p.XTI` |
| `model->JFETvtotc`     | `p.VTOTC` |
| `model->JFETbetatce`   | `p.BETATCE` |
| `model->JFETtcv`       | `p.TCV` |
| `model->JFETbex`       | `p.BEX` |
| `model->JFETthreshold` | `p.VTO` |
| `model->JFETbeta`      | `p.BETA` |
| `model->JFETgateSatCurrent` | `p.IS` |
| `model->JFETtnom`      | `p.TNOM` |
| `here->JFETtemp`       | `temp` (local in `computeJfetTempParams`) |
| `model->JFETxtiGiven`     | `given.xtiGiven` (`this._xtiGiven`) |
| `model->JFETvtotcGiven`   | `given.vtotcGiven` (`this._vtotcGiven`) |
| `model->JFETbetatceGiven` | `given.betatceGiven` (`this._betatceGiven`) |
| `here->JFETtSatCur`    | `tSatCur` (returned `tp.tSatCur`) |
| `here->JFETtThreshold` | `tThreshold` (returned `tp.tThreshold`) |
| `here->JFETtBeta`      | `tBeta` (returned `tp.tBeta`) |

## Load (jfetload.c::JFETload)

| ngspice | digiTS |
|---|---|
| `ckt->CKTmode` | `mode` (`ctx.cktMode`) |
| `MODEDCTRANCURVE \| MODETRAN \| MODEAC \| MODEINITSMSIG` | `MODEDCTRANCURVE \| MODETRAN \| MODEAC \| MODEINITSMSIG` (capGate) |

## Model-param table / getter / setter (jfet.c, jfetmask.c, jfetmpar.c)

| ngspice | digiTS |
|---|---|
| `JFETmPTable[]` rows (vtotc/betatce/xti/eg/kf/af) | `NJFET_PARAM_DEFS` rows (VTOTC/BETATCE/XTI/EG/KF/AF) |
| `JFETmAsk` getter cases | property-bag read (`props.getModelParam(...)`) — no getter method |
| `JFETmParam` setter cases | `NJFETElement.setParam` generic `key in this._params` branch + `_xxxGiven = true` |

## Instance-param setter / IC parse (jfetpar.c::JFETparam)

| ngspice | digiTS |
|---|---|
| `switch (param)` | `setParam` `if/else` chain |
| `JFET_IC` vec parse (icVGS=vec[1], icVDS=vec[0]) | `emitGroup { name:"IC", index:0/1 }` on ICVDS/ICVGS |
| `JFET_IC_VDS` / `here->JFETicVDS` | `ICVDS` / `p.ICVDS` |
| `JFET_IC_VGS` / `here->JFETicVGS` | `ICVGS` / `p.ICVGS` |

## AC small-signal load (jfetacld.c::JFETacLoad → NJFETElement.stampAc)

The whole `JFETacLoad` function maps to `NJFETElement.stampAc(solver, omega,
ctx, rhsRe, rhsIm)`. The C model/instance loop (`JFETnextModel` /
`JFETinstances` / `JFETnextInstance`, hunk h001) is the per-element-invocation
plumbing already documented above (zero-line TS delta). The body is the 22
admittance stamps.

| ngspice | digiTS |
|---|---|
| `model->JFETdrainConduct * here->JFETarea` | `(params.RD > 0 ? 1/params.RD : 0) * params.AREA` (gdpr) |
| `model->JFETsourceConduct * here->JFETarea` | `(params.RS > 0 ? 1/params.RS : 0) * params.AREA` (gspr) |
| `*(ckt->CKTstate0 + here->JFETgm)`  | `s0[base + SLOT_GM]`  (gm) |
| `*(ckt->CKTstate0 + here->JFETgds)` | `s0[base + SLOT_GDS]` (gds) |
| `*(ckt->CKTstate0 + here->JFETggs)` | `s0[base + SLOT_GGS]` (ggs) |
| `*(ckt->CKTstate0 + here->JFETggd)` | `s0[base + SLOT_GGD]` (ggd) |
| `*(ckt->CKTstate0 + here->JFETqgs) * ckt->CKTomega` | `s0[base + SLOT_QGS] * omega` (xgs) |
| `*(ckt->CKTstate0 + here->JFETqgd) * ckt->CKTomega` | `s0[base + SLOT_QGD] * omega` (xgd) |
| `here->JFETm` | `params.M` (m) |
| `*(ptr) += val` | `solver.stampElement(handle, val)` |
| `*(ptr +1) += val` | `solver.stampElementImag(handle, val)` |
| `*(ptr) -= val` | `solver.stampElement(handle, -(val))` (additive primitive) |
| `*(ptr +1) -= val` | `solver.stampElementImag(handle, -(val))` |
| `JFETdrainDrainPtr` | `_hDD` |
| `JFETgateGatePtr` | `_hGG` |
| `JFETsourceSourcePtr` | `_hSS` |
| `JFETdrainPrimeDrainPrimePtr` | `_hDPDP` |
| `JFETsourcePrimeSourcePrimePtr` | `_hSPSP` |
| `JFETdrainDrainPrimePtr` | `_hDDP` |
| `JFETgateDrainPrimePtr` | `_hGDP` |
| `JFETgateSourcePrimePtr` | `_hGSP` |
| `JFETsourceSourcePrimePtr` | `_hSSP` |
| `JFETdrainPrimeDrainPtr` | `_hDPD` |
| `JFETdrainPrimeGatePtr` | `_hDPG` |
| `JFETdrainPrimeSourcePrimePtr` | `_hDPSP` |
| `JFETsourcePrimeGatePtr` | `_hSPG` |
| `JFETsourcePrimeSourcePtr` | `_hSPS` |
| `JFETsourcePrimeDrainPrimePtr` | `_hSPDP` |

## LTE truncation (jfettrun.c::JFETtrunc)

| ngspice | digiTS |
|---|---|
| `CKTterr(here->JFETqgs, ...)` | `cktTerr(... QGS/CQGS ...)` in `getLteTimestep` |
| `CKTterr(here->JFETqgd, ...)` | `cktTerr(... QGD/CQGD ...)` in `getLteTimestep` |
