# Rename map — `sw` (VSWITCH) device, ngspice → digiTS

`tsFile`: `src/components/active/analog-switch.ts`

Documentation only. The verifier re-derives equivalence independently; a wrong
row here cannot produce a false APPLIED. Kept accurate for cross-hunk
consistency.

## Identifiers

| ngspice (v41) | digiTS | Notes |
|---|---|---|
| `SWonResistance` | `_rOn` / `rOn` param | model param, swdefs.h |
| `SWoffResistance` | `_rOff` / `rOff` param | model param |
| `SWvThreshold` | `_vThreshold` / `vThreshold` param | model param |
| `SWvHysteresis` | `_vHysteresis` / `vHysteresis` param | model param |
| `SWonConduct` | `1 / rOnNow` (derived in `load()` / `stampAc()`) | swdefs.h:72; not stored, derived at stamp time |
| `SWoffConduct` | `1 / rOffNow` (derived in `load()` / `stampAc()`) | swdefs.h:73 |
| `SWzero_stateGiven` | `_zeroStateGiven` | instance flag, swdefs.h:46 |
| `SW_IC_ON` (`on` keyword) | `on` instance param → `_zeroStateGiven = true` | swparam.c:21-24 |
| `SW_IC_OFF` (`off` keyword) | `off` instance param → `_zeroStateGiven = false` | swparam.c:25-28 |
| `SWstate` | `_stateBase` | start of element's state-vector slice |
| `SWswitchstate` (= `SWstate+0`) | `SLOT_STATE` (= 0) | swdefs.h; `s0[base + SLOT_STATE]` |
| `SWctrlvalue` (= `SWstate+1`) | `SLOT_V_CTRL` (= 1) | swdefs.h; saved control voltage |
| `CKTstate0[...]` | `this._pool.states[0][...]` | current state vector |
| `CKTstate1[...]` | `this._pool.states[1][...]` | previous state vector |
| `CKTrhsOld[SWposCntrlNode]` − `CKTrhsOld[SWnegCntrlNode]` | `ctx.rhsOld[nCtrl]` (single-ended; negCntrl = ground) | swload.c control voltage |
| `CKTdeltaOld[0]` | `deltaOld[0]` | SWtrunc current trial delta |
| `SWposNode` | `_nIn` (SPST) / `_nCom` (SPDT) | positive signal node |
| `SWnegNode` | `_nOut` (SPST) / `_nNO`,`_nNC` (SPDT) | negative signal node |
| `SWposCntrlNode` | `_nCtrl` | positive control node |
| `SWposPosPtr` | `_hPP` (SPST) / `_hNO_PP`,`_hNC_PP` (SPDT) | TSTALLOC handle, swsetup.c:59 |
| `SWposNegPtr` | `_hPN` / `_hNO_PN`,`_hNC_PN` | swsetup.c:60 |
| `SWnegPosPtr` | `_hNP` / `_hNO_NP`,`_hNC_NP` | swsetup.c:61 |
| `SWnegNegPtr` | `_hNN` / `_hNO_NN`,`_hNC_NN` | swsetup.c:62 |
| `g_now` | `g_now` | selected conductance |
| `SWnextModel`/`SWinstances`/`SWnextInstance` | (no counterpart) | C model/instance linked-list walk; digiTS invokes per element |
| `SWmodType`/`SWmodName`/`SWname`/GENmodel/GENinstance | (no counterpart) | C struct-embedding / runtime plumbing |
| `SWnSize`/`SWpTSize`/`SWmPTSize`/`SWiSize`/`SWmSize` | (no counterpart) | sizes derived from schema / param-def objects |
| `SWnVar`/`SWnoise` | (no counterpart) | noise unimplemented |

## v41 #define → enum (swdefs.h#h002)

Byte-identical integer values; digiTS keys params by name, so the ids have no
direct counterpart. Device params `SW_IC_ON=1 … SW_POWER=8`; model params
`SW_MOD_SW=101 … SW_MOD_GOFF=107`.

## State-machine sentinels (swload.c)

`REALLY_OFF=0`, `REALLY_ON=1`, `HYST_OFF=2`, `HYST_ON=3` — same numeric
constants in digiTS (`analog-switch.ts:93-96`).
