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

## LTE truncation (jfettrun.c::JFETtrunc)

| ngspice | digiTS |
|---|---|
| `CKTterr(here->JFETqgs, ...)` | `cktTerr(... QGS/CQGS ...)` in `getLteTimestep` |
| `CKTterr(here->JFETqgd, ...)` | `cktTerr(... QGD/CQGD ...)` in `getLteTimestep` |
