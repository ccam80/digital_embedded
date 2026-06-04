# Reconstruction spec — `dio#recon/v41NewFeatures`

Build the three v41-new diode subsystems as ONE coherent reconstruction:
**(1) electro-thermal self-heating**, **(2) recombination current**, and
**(3) level=3 parasitic geometry caps**. They all weave into the same
`DIOload` / `DIOsetup` / `DIOtempUpdate` bodies (`ref/ngspice/src/spicelib/devices/dio/dioload.c`,
`diosetup.c`, `diotemp.c`), so a single applier rebuilds them together onto the
single digiTS target `src/components/semiconductors/diode.ts`. All three are
**v41-new** (no v26 baseline subset exists in digiTS today); the reconstruction
targets the v41 state directly — it does NOT rebuild a v26 layer first.

`dio` is an **IN** device class (`device-class-scope.md`), so each of these
three ngspice diode subsystems digiTS omits is a reconstruction item — not an
accepted divergence and not an open question. The IN-class completeness rule
forbids OMITTING ngspice behavior (the self-heating thermal terminal,
recombination arm, and level-3 metal/poly overlap caps must be rebuilt
bit-exact) but permits ADDITIONAL digiTS behavior (the existing digiTS knee /
sidewall / tunnel extensions are unchanged).

This spec implements the **RESOLVED** ruling of the hybrid open-question #20/#21
(`OPEN-QUESTIONS-WORKLOG.md:83-84, 313-332`) and the #38/#39 terminal/limiter
rulings (`OPEN-QUESTIONS-WORKLOG.md:101-102, 466-472`):
- **#20 HYBRID** — `dio#recon/diotempUpdate` (the v26-baseline temp-model gap)
  stays a SEPARATE recon that lands FIRST; `selfHeating` + `recombination` +
  `level3GeoCap` MERGE into THIS single `dio#recon/v41NewFeatures` (whose
  `blocks[]` is the union of the three former recons' hunks).
- **#21 MOOT** — the four multiblock hunks (`dio.c#h006`, `diodefs.h#h008/#h009`,
  `diompar.c#h001`) all block on this single recon; no `splits.json` entries.
- **#38 — `Tj` is ALWAYS present (3-terminal).** ngspice `DIOnames` is the
  unconditional 3-element `{"D+","D-","Tj"}` (`dio.c:137-143`, `DIOnSize=3`).
  Declare `Tj` unconditionally; wire its node into the matrix only when
  self-heating is on (`selfheat`, `diosetup.c:325`); render the pin
  conditionally for UX. Affects the `.dig` symbol and every three-surface test.
- **#39 — reuse the existing `limitlog`** (`newton-raphson.ts:295-320`, ported
  from `DEVlimitlog` `devsup.c:153-184`); it matches the
  `(deltemp, deltempOld, limTol) -> {value, check}` contract the thermal step
  needs.

Authoring contract: this spec is **documentation**. No code. No tests. The
implementer authors the TypeScript edit against this spec; the verifier checks
the edit against the ngspice citations herein. `DiodeAnalogElement`
(`diode.ts:541-976`), its `DIODE_SCHEMA` / `DIODE_PARAM_DEFS` / `dioTemp` /
`createDiodeElement` surrounds, and the `DiodeElement` render/pin surface
(`diode.ts:999-1086`) are the rebuild targets.

Per `CLAUDE.md` comment-hygiene: every reconstructed source comment cites the
current `ref/ngspice/src/spicelib/devices/dio/<file>:line` and explains the
mechanism in present tense — no `v26`/`v41`/era tags, no migration narrative.

**Dependency on `dio#recon/diotempUpdate`:** the self-heating subsystem calls
`DIOtempUpdate` at `Temp = DIOtemp + delTemp` every NR iteration
(`dioload.c:254-262`) and consumes the **temperature derivatives**
(`DIOtSatCur_dT`, `DIOtSatSWCur_dT`, `DIOtConductance_dT`,
`DIOtRecSatCur_dT`) that `diotemp.c:116-149, 237-238` produce. Those `_dT`
outputs are part of the faithful v41 `DIOtempUpdate` body that
`dio#recon/diotempUpdate` rebuilds. THIS recon authors the `_dT` consumers (the
self-heating Jacobian) and the `_dT` producers that are NEW to the recombination
path (`DIOtRecSatCur_dT`); the broader temp-model derivative production is the
sibling recon's responsibility. Where a `_dT` quantity is produced by
`DIOtempUpdate` and only consumed here, this spec cites the producer line and
flags the consumption; it does not re-author the producer.

## Current digiTS state

digiTS's diode is a **2-pin** `[A, K]` device (`diode.ts:1065-1086`,
`buildDiodePinDeclarations`) with a **5-slot** state schema (`DIODE_SCHEMA`,
`diode.ts:75-87`: `VD, ID, GEQ, Q, CAP_CURRENT`). It has NONE of the three
v41-new subsystems:

| Subsystem | ngspice anchor | digiTS state today |
|---|---|---|
| Self-heating thermal terminal | `dio.c:137-143` (3 names), `diodefs.h:41` `DIOtempNode`, `:60-66` 7 thermal ptrs, `:202-208` 4 thermal state slots, `DIOnumStates=9` | **ABSENT** — 2-pin, no `Tj` node, no thermal stamps, 5 state slots |
| `DIOthermal` flag + `rth0`/`cth0` | `dioparam.c:47-49` (`DIO_THERMAL`), `diosetup.c:203-208` (`rth0`/`cth0` defaults), `dio.c:122-123` (model IOP rows) | **ABSENT** from `DIODE_PARAM_DEFS` (`diode.ts:93-125`) |
| Recombination current `isr`/`nr` | `dio.c:111-112` (IOP), `diosetup.c:182-187` (defaults), `diotemp.c:143-149` (`DIOtRecSatCur`/`_dT`), `dioload.c:324-340` | **ABSENT** — `DIODE_PARAM_DEFS` has no `ISR`/`NR`; `computeDiodeIV` (`diode.ts:397-418`) has no recombination arm |
| Level=3 parasitic geom caps | `dio.c:125-132` (8 IOP rows), `diosetup.c:259-291` (area/perim/cmetal/cpoly derivation), `dioload.c:455` (`capd += DIOcmetal + DIOcpoly`) | **ABSENT** — no `LM/LP/WM/WP/XOM/XOI/XM/XP`, no `level`, no `DIOcmetal`/`DIOcpoly`; `diode.ts:815-817` cap path is `Cj + Ct` only |

The `dioTemp` helper (`diode.ts:275-386`) returns `DioTempParams` with the
junction/sidewall temp scaling but **no** `_dT` derivative fields and **no**
`tRecSatCur`. `computeDiodeIV` (`diode.ts:397-418`) is the bottom-current
3-region arm only. The `load()` body (`diode.ts:594-878`) carries IKF/IKR,
sidewall, and the cap companion, but no thermal voltage solve, no `delTemp`
limiting, no recombination, no `cmetal`/`cpoly` fold, and no thermal-node
stamps/RHS. `DIODE_SCHEMA` is 5 slots vs ngspice's `DIOnumStates=9`
(`diodefs.h:208`).

`CONSTepsSiO2` (`const.h:51-53` = `3.9 * CONSTepsZero`) is **absent** from
`src/core/constants.ts` (verified: no `epsSiO2`/`epsrSiO2`/`epsZero` symbol).
The reconstruction adds it (Part D).

With this recon `APPLIED`, the **31 blocked v41 hunks** (final section) apply
onto the rebuilt baseline as ordinary per-hunk deltas.

## Part A — The `Tj` thermal terminal (3-terminal diode, always present) — #38

ngspice's `DIOnames` is unconditional 3-element (`dio.c:137-143`):

```c
char *DIOnames[] = {
    "D+",
    "D-",
    "Tj"
};
int DIOnSize = NUMELEMS(DIOnames);   /* = 3 */
```

The third terminal `Tj` is the **junction-temperature node** (`DIOtempNode`,
`diodefs.h:41`). Per #38 it is ALWAYS declared (the diode is structurally
3-terminal); only its matrix wiring is conditional on `selfheat`
(`diosetup.c:325`, Part E). Its node voltage IS the temperature delta
`delTemp` over `rth0` (`diodefs.h:205` comment "thermal voltage over rth0").

### Pin layout change (`diode.ts:1065-1086`)

`buildDiodePinDeclarations()` adds a third pin `Tj` after `A`/`K`:

```ts
// dio.c:137-143 — DIOnames is the unconditional 3-terminal {D+, D-, Tj}.
// Tj is the junction-temperature node (diodefs.h:41 DIOtempNode); its node
// carries delTemp (the temperature rise over rth0) when self-heating is on.
{
  direction: PinDirection.OUTPUT,
  label: "Tj",
  defaultBitWidth: 1,
  position: { x: 2, y: 1 },   // implementer places below the body for the symbol
  isNegatable: false,
  isClockCapable: false,
  kind: "signal",
},
```

The render `draw()` (`diode.ts:1023-1057`) draws the `Tj` lead **conditionally**
(rendered only when self-heating is enabled — UX gate per #38; the pin is always
declared for topology but only painted when `thermal` is on). The implementer
gates the lead-draw on the resolved `thermal` model param.

### Thermal-node resolution in `setup()` (`diode.ts:554-588`)

`setup()` reads `this.pinNodes.get("Tj")` into a closure node id `nodeTemp`.
The `selfheat` predicate (`diosetup.c:325`, `dioload.c:80`) is:

```ts
// diosetup.c:325 / dioload.c:80 — selfheat gates thermal-node matrix wiring.
//   selfheat = (DIOtempNode > 0) && DIOthermal && DIOrth0Given
const selfheat = nodeTemp > 0 && params.THERMAL !== 0 && _rth0Given;
```

When `selfheat` is false, the `Tj` node is left unstamped (it floats / is
grounded by the engine's unused-node handling) exactly as ngspice leaves
`DIOtempNode` unwired. `nodeTemp > 0` mirrors ngspice's "node 0 is ground" guard.

### Identifier mapping (terminal + nodes)

| ngspice identifier | digiTS identifier | source |
|---|---|---|
| `DIOposNode` | `nodeAnode` | `diodefs.h:39` |
| `DIOnegNode` | `nodeCathode` | `diodefs.h:40` |
| `DIOtempNode` | `nodeTemp` | `diodefs.h:41` |
| `DIOposPrimeNode` | `_posPrimeNode` | `diodefs.h:42` |
| `selfheat` | `selfheat` (load-local + setup-local) | `dioload.c:80`, `diosetup.c:325` |

Per the three-surface rule (`CLAUDE.md`), the `Tj` terminal addition is verified
across headless (`DefaultSimulatorFacade`), MCP (`circuit_*` netlist round-trip
of the 3-pin device), and E2E (`.dig` symbol with the third pin) — see
Acceptance criteria.

## Part B — Self-heating model params + `DIOthermal` flag + state growth

### Model / instance parameters

| ngspice param | IOP row | digiTS param | default | group | source |
|---|---|---|---|---|---|
| `DIOthermal` (instance flag) | `dio.c:26` (`DIO_THERMAL`, IF_FLAG) | `THERMAL` | `0` | instance, `emit:"flag"` | `dioparam.c:47-49` |
| `DIOrth0` | `dio.c:122` (`DIO_MOD_RTH0`) | `RTH0` | `0` | secondary | `diosetup.c:203-205` |
| `DIOcth0` | `dio.c:123` (`DIO_MOD_CTH0`) | `CTH0` | `1e-5` | secondary | `diosetup.c:206-208` |

Added to `DIODE_PARAM_DEFS` (`diode.ts:93-125`):

```ts
// dio.c:122-123 (DIO_MOD_RTH0/CTH0) — self-heating thermal RC.
// diosetup.c:203-208 — rth0 defaults 0 (no self-heating drive), cth0 defaults 1e-5.
RTH0: { default: 0,    unit: "K/W", description: "Self-heating thermal resistance" },
CTH0: { default: 1e-5, unit: "J/K", description: "Self-heating thermal capacitance" },
// dio.c:26 (DIO_THERMAL, IF_FLAG) — per-instance self-heating mode selector.
THERMAL: { default: 0, emit: "flag", description: "Self-heating mode (0=off, 1=on)" },
```

`_rth0Given` mirrors `DIOrth0Given` (`diodefs.h:284`): read in the constructor
from `props.isModelParamGiven("RTH0")`, mirroring `_tempGiven`
(`diode.ts:524`). The `selfheat` predicate (Part A) reads it. `params.THERMAL`
mirrors the instance `DIOthermal` flag (`diodefs.h:99`).

### State schema growth 5 -> 9 (`DIODE_SCHEMA`, `diode.ts:75-87`)

ngspice `DIOnumStates = 9` (`diodefs.h:208`) with the new slots
(`diodefs.h:202-206`):

| ngspice slot | offset | digiTS slot | meaning | source |
|---|---|---|---|---|
| `DIOvoltage` | `DIOstate+0` | `VD` (exists) | junction voltage | `diodefs.h:196` |
| `DIOcurrent` | `+1` | `ID` (exists) | diode current | `diodefs.h:197` |
| `DIOconduct` | `+2` | `GEQ` (exists) | conductance | `diodefs.h:198` |
| `DIOcapCharge` | `+3` | `Q` (exists) | junction charge | `diodefs.h:199` |
| `DIOcapCurrent` | `+4` | `CAP_CURRENT` (exists) | cap companion current | `diodefs.h:200` |
| `DIOqth` | `+5` | `QTH` (NEW) | thermal-cap charge | `diodefs.h:202` |
| `DIOcqth` | `+6` | `CQTH` (NEW) | thermal-cap current | `diodefs.h:203` |
| `DIOdeltemp` | `+7` | `DELTEMP` (NEW) | temperature delta (Tj node voltage) | `diodefs.h:205` |
| `DIOdIdio_dT` | `+8` | `DIDIO_DT` (NEW) | dI_diode/dT | `diodefs.h:206` |

```ts
export const DIODE_SCHEMA: StateSchema = defineStateSchema("DiodeElement", [
  { name: "VD",   doc: "pnjlim-limited junction voltage — diodefs.h:196 DIOvoltage (DIOstate+0)" },
  { name: "ID",   doc: "Diode current at operating point — diodefs.h:197 DIOcurrent (DIOstate+1)" },
  { name: "GEQ",  doc: "NR companion conductance — diodefs.h:198 DIOconduct (DIOstate+2)" },
  { name: "Q",    doc: "Junction charge — diodefs.h:199 DIOcapCharge (DIOstate+3)" },
  { name: "CAP_CURRENT", doc: "NIintegrate companion current / capd — diodefs.h:200 DIOcapCurrent (DIOstate+4)" },
  { name: "QTH",     doc: "Thermal-cap charge (cth0*delTemp) — diodefs.h:202 DIOqth (DIOstate+5)" },
  { name: "CQTH",    doc: "Thermal-cap NIintegrate companion current — diodefs.h:203 DIOcqth (DIOstate+6)" },
  { name: "DELTEMP", doc: "Temperature delta = Tj node voltage over rth0 — diodefs.h:205 DIOdeltemp (DIOstate+7)" },
  { name: "DIDIO_DT", doc: "dI_diode/dT, used by predictor + convergence — diodefs.h:206 DIOdIdio_dT (DIOstate+8)" },
]);

const SLOT_VD       = 0;
const SLOT_ID       = 1;
const SLOT_GEQ      = 2;
const SLOT_Q        = 3;
const SLOT_CCAP     = 4;
const SLOT_QTH      = 5;
const SLOT_CQTH     = 6;
const SLOT_DELTEMP  = 7;
const SLOT_DIDIO_DT = 8;
```

`this.stateSize = DIODE_SCHEMA.size` (now 9) is unchanged in form
(`diode.ts:549-551`); the allocation grows automatically. ngspice's
`*states += DIOnumStates` (`diosetup.c:298`) maps to `ctx.allocStates(9)`.

Per `MEMORY.md` "No accept() — all state in StatePool": the new thermal slots
hold their history in the pool; `DELTEMP`/`QTH` read `s1[...]` and write
`s0[...]` in `load()` exactly as ngspice reads `CKTstate1`/writes `CKTstate0`.

## Part C — Self-heating in `load()` (rebuild of `dioload.c:80-588`)

The self-heating path threads through the entire `DIOload` body. The current
`diode.ts` `load()` (`diode.ts:594-878`) is restructured to interleave the
thermal solve. All `delTemp`/`Temp`/`dIdio_dT` quantities are zero when
`selfheat` is false, so the non-self-heating numerics are unchanged.

### C.1 — Thermal voltage selection per CKTmode (`dioload.c:135-249`)

Alongside each `vd` selection branch, `delTemp` is selected from the same state
plane (`dioload.c:135-177`):

| CKTmode | `vd` source | `delTemp` source | ngspice |
|---|---|---|---|
| `MODEINITSMSIG` | `s0[VD]` | `s0[DELTEMP]` | `dioload.c:135-137` |
| `MODEINITTRAN` | `s1[VD]` | `s1[DELTEMP]` | `dioload.c:138-140` |
| `MODEINITJCT && MODETRANOP && MODEUIC` | `DIOinitCond` | (unchanged; stays 0) | `dioload.c:141-143` |
| `MODEINITJCT && DIOoff` | `0` | `0` | `dioload.c:144-146` |
| `MODEINITJCT` | `tVcrit` | `0` | `dioload.c:147-149` |
| `MODEINITFIX && DIOoff` | `0` | `0` | `dioload.c:150-152` |
| `MODEINITPRED` (else, `#ifndef PREDICTOR`) | `DEVpred(DIOvoltage)` | `DEVpred(DIOdeltemp)` | `dioload.c:155-169` |
| normal NR (else) | `rhsOld[posPrime]-rhsOld[neg]` | `selfheat ? rhsOld[tempNode] : 0` | `dioload.c:172-178` |

The `MODEINITPRED` arm also copies `s0[DIDIO_DT]=s1[DIDIO_DT]` and
`s0[QTH]=s1[QTH]` (`dioload.c:166-169`) and calls `DEVpred` on `DIOdeltemp`
(`dioload.c:165`). The normal-NR arm (`dioload.c:172-182`) reads
`delTemp = rhsOld[nodeTemp]` and seeds the thermal-cap charge:

```ts
// dioload.c:172-182 — normal NR: vd & delTemp from rhsOld; seed thermal-cap charge.
const va = voltages[nodeJunction];
const vc = voltages[nodeCathode];
vdRaw = va - vc;
delTemp = selfheat ? voltages[nodeTemp] : 0.0;
// dioload.c:178 — DIOqth = cth0 * delTemp (thermal capacitor charge tracks delTemp).
s0[base + SLOT_QTH] = params.CTH0 * delTemp;
if (mode & MODEINITTRAN) {
  // dioload.c:179-182 — first transient step seeds state1 thermal charge = state0.
  s1[base + SLOT_QTH] = s0[base + SLOT_QTH];
}
```

`delvd` / `cdhat` gain the thermal term (`dioload.c:186-190`): the prediction
`cdhat` adds `s0[DIDIO_DT] * deldelTemp` where
`deldelTemp = delTemp - s0[DELTEMP]`.

### C.2 — `delTemp` limiting via `limitlog` (`dioload.c:244-248`) — #39

After the junction-voltage `pnjlim` (existing, `diode.ts:649-674`), when
`selfheat`:

```ts
// dioload.c:244-246 — limitlog damps the per-iteration temperature step.
//   DEVlimitlog(delTemp, state0[DIOdeltemp], 100, &Check_th)
// digiTS limitlog (newton-raphson.ts:295-320, ported from devsup.c:153-184).
let Check_th = 0;
if (selfheat) {
  const r = limitlog(delTemp, s0[base + SLOT_DELTEMP], 100);
  delTemp = r.value;
  Check_th = r.check;
} else {
  delTemp = 0.0;   // dioload.c:247-248
}
```

The `limTol` argument is the literal `100` (`dioload.c:246`). `Check_th`
contributes to the convergence bump in C.6.

### C.3 — `DIOtempUpdate` re-eval at `Temp + delTemp` (`dioload.c:254-262`)

```ts
// dioload.c:254-262 — when self-heating, re-evaluate temperature-dependent
// parameters at the elevated junction temperature Temp = DIOtemp + delTemp,
// then recompute vt / vte / vtebrk at that temperature.
let Temp: number;
if (selfheat) {
  Temp = deviceTemp + delTemp;                 // dioload.c:255
  applyDioTempResult(dioTemp({ ...tempArgs }, Temp));   // dioload.c:256 DIOtempUpdate
  vt = CONSTKoverQ * Temp;                      // dioload.c:257
} else {
  Temp = deviceTemp;                            // dioload.c:261
}
const nVtLocal = params.N * vt;                 // vte = DIOemissionCoeff * vt
const vtebrk = params.NBV * vt;                 // dioload.c:259 vtebrk
```

`deviceTemp` is the device base temperature (`DIOtemp`, the
`_tempGiven ? params.TEMP : ctx.cktTemp` value already resolved in
`computeTemperature`, `diode.ts:949-958`). The re-eval inside `load()` calls
the **same** `dioTemp` helper at the elevated `Temp`; this is the per-iteration
`DIOtempUpdate(model, here, Temp, ckt)` call. `dioTemp` must by then return the
`_dT` derivative fields (Part F) used by the Jacobian — those fields are
produced by the `dio#recon/diotempUpdate` body; this recon consumes them.

### C.4 — Recombination, sidewall, tunnel `_dT` accumulation

The bottom/sidewall/tunnel current arms (`dioload.c:264-391`) each gain a
`cdb_dT` / `cdsw_dT` temperature-derivative accumulation that feeds
`dIdio_dT = cdb_dT + cdsw_dT` (`dioload.c:391`). Part G details the recombination
arm; the sidewall/tunnel `_dT` lines (`dioload.c:281,291,300,308,372,384`) are
authored when those arms execute. `dIdio_dT` is the total
diode-current/temperature derivative used by the predictor (C.1), convergence
(C.6), and the thermal Jacobian (C.5). It is stored to `s0[DIDIO_DT]`
(`dioload.c:533`).

### C.5 — Thermal-cap NIintegrate + dissipated power + Jacobian (`dioload.c:506-588`)

When `selfheat`, after the junction-cap NIintegrate (existing,
`diode.ts:835-843`), integrate the thermal capacitor (`dioload.c:506-514`):

```ts
// dioload.c:506-514 — integrate the thermal capacitor cth0 over DIOqth, giving
// the thermal companion conductance gcTt and companion current ceqqth.
let gcTt = 0, ceqqth = 0;
if (selfheat) {
  const qth0 = params.CTH0 * delTemp;          // dioload.c:178 thermal charge
  s0[base + SLOT_QTH] = qth0;
  const cqthPrev = s1[base + SLOT_CQTH];
  const thRes = niIntegrate(method, order, params.CTH0, ag,
                            qth0, s1[base + SLOT_QTH],
                            [s2[base + SLOT_QTH], s3[base + SLOT_QTH], 0, 0, 0],
                            cqthPrev);
  gcTt = thRes.geq;                             // companion conductance
  ceqqth = thRes.ceq;                           // companion current (ngspice ceqqth)
  s0[base + SLOT_CQTH] = thRes.ccap;
  if (mode & MODEINITTRAN) {
    s1[base + SLOT_CQTH] = thRes.ccap;          // dioload.c:510-513
  }
}
```

`niIntegrate` returns `{ccap, ceq, geq}` (`ni-integrate.ts:28`); `ceq` is
ngspice's `ceqqth`, `geq` is `gcTt`. The thermal NIintegrate is gated inside the
same charge-storage block as the junction cap (`dioload.c:419-516`,
`(MODEDCTRANCURVE|MODETRAN|MODEAC|MODEINITSMSIG) || (MODETRANOP && MODEUIC)`).

Then the dissipated-power load and its Jacobian (`dioload.c:540-557`):

```ts
// dioload.c:540-557 — dissipated power Ith and its full Jacobian.
let Ith = 0, dIth_dVrs = 0, dIth_dVdio = 0, dIth_dT = 0, dIrs_dT = 0, vrs = 0;
if (selfheat) {
  // dioload.c:542 — vrs = voltage across the series resistance.
  vrs = voltages[nodeAnode] - voltages[_posPrimeNode];
  // dioload.c:543 — Ith = vd*cd + vrs^2 * gspr (diode + series-R dissipation).
  Ith = vdLimited * cd + vrs * vrs * gspr;
  const dIrs_dVrs = gspr;                                  // dioload.c:544
  const dIrs_dgspr = vrs;                                  // dioload.c:545
  dIrs_dT = dIrs_dgspr * tConductance_dT;                  // dioload.c:546
  dIth_dVrs = vrs * gspr;                                  // dioload.c:547
  const dIth_dIrs = vrs;                                   // dioload.c:548
  dIth_dVrs = dIth_dVrs + dIth_dIrs * dIrs_dVrs;           // dioload.c:549
  dIth_dT = dIth_dIrs * dIrs_dT + dIdio_dT * vdLimited;    // dioload.c:550
  dIth_dVdio = cd + vdLimited * gd;                        // dioload.c:551
}
```

`gspr = tConductance` (`DIOtConductance`, `diode.ts` series-R conductance) and
`tConductance_dT` (`DIOtConductance_dT`, `diotemp.c:237-238`) is produced by the
diotempUpdate recon and consumed here. (`gspr` is the area/temp-scaled series
conductance; when `RS==0`, `gspr==0` and the dissipation reduces to `vd*cd`.)

### C.6 — Convergence bump (`dioload.c:523-528`) and state writes (`dioload.c:529-533`)

```ts
// dioload.c:523-528 — bump CKTnoncon when EITHER the junction pnjlim OR the
// thermal limitlog damped (Check_dio || Check_th).
if (!(mode & MODEINITFIX) || !params.OFF) {
  if (Check_th === 1 || pnjlimLimited) ctx.noncon.value++;
}
// dioload.c:529-533 — state0 writes (VD, ID, GEQ, DELTEMP, DIDIO_DT).
s0[base + SLOT_VD]       = vdLimited;
s0[base + SLOT_ID]       = cd;
s0[base + SLOT_GEQ]      = gd;
s0[base + SLOT_DELTEMP]  = delTemp;
s0[base + SLOT_DIDIO_DT] = dIdio_dT;
```

(The current `diode.ts` bumps `ctx.noncon` at `diode.ts:676`; the rebuild merges
the thermal `Check_th` into that single bump per `dioload.c:524`.)

### C.7 — Thermal RHS + matrix stamps (`dioload.c:564-588`)

The junction RHS/matrix stamps (existing, `diode.ts:794-800`) are unchanged. The
self-heating block adds **four RHS** loads (`dioload.c:564-569`) and **seven
matrix** stamps (`dioload.c:580-588`):

```ts
// dioload.c:564-569 — self-heating RHS contributions across the four nodes.
if (selfheat) {
  stampRHS(ctx.rhs, nodeAnode,      dIrs_dT * delTemp);
  stampRHS(ctx.rhs, _posPrimeNode,  dIdio_dT * delTemp - dIrs_dT * delTemp);
  stampRHS(ctx.rhs, nodeCathode,   -dIdio_dT * delTemp);
  stampRHS(ctx.rhs, nodeTemp,
           Ith - dIth_dVdio * vdLimited - dIth_dVrs * vrs - dIth_dT * delTemp - ceqqth);
}
// dioload.c:580-588 — seven thermal-node Jacobian stamps.
if (selfheat) {
  solver.stampElement(_hTempPos,      -dIth_dVrs);
  solver.stampElement(_hTempPosPrime, -dIth_dVdio + dIth_dVrs);
  solver.stampElement(_hTempNeg,       dIth_dVdio);
  solver.stampElement(_hTempTemp,     -dIth_dT + 1 / params.RTH0 + gcTt);
  solver.stampElement(_hPosTemp,       dIrs_dT);
  solver.stampElement(_hPosPrimeTemp,  dIdio_dT - dIrs_dT);
  solver.stampElement(_hNegTemp,      -dIdio_dT);
}
```

The `1/params.RTH0` term (`dioload.c:584`) is the thermal-resistance conductance
on the `Tj`-`Tj` diagonal; `selfheat` guarantees `DIOrth0Given` so `RTH0 != 0`.
The seven handles `_hTempPos`…`_hNegTemp` are allocated in `setup()` (Part E) in
the exact `diosetup.c:342-348` TSTALLOC order.

### Identifier mapping (self-heating load)

| ngspice (`dioload.c`) | digiTS | line |
|---|---|---|
| `selfheat` | `selfheat` | `dioload.c:80` |
| `delTemp` | `delTemp` | `dioload.c:104` |
| `Temp` | `Temp` | `dioload.c:255` |
| `gcTt` | `gcTt` | `dioload.c:508` |
| `ceqqth` | `ceqqth` | `dioload.c:508` |
| `Ith` | `Ith` | `dioload.c:543` |
| `vrs` | `vrs` | `dioload.c:542` |
| `dIth_dVrs` / `dIth_dVdio` / `dIth_dT` | same | `dioload.c:547,551,550` |
| `dIrs_dT` | `dIrs_dT` | `dioload.c:546` |
| `dIdio_dT` | `dIdio_dT` | `dioload.c:391,533` |
| `here->DIOtConductance` | `gspr` (= series-R conductance) | `dioload.c:108,268` |
| `here->DIOtConductance_dT` | `tConductance_dT` | `dioload.c:546` (producer `diotemp.c:237-238`) |
| `model->DIOcth0` | `params.CTH0` | `dioload.c:178,508` |
| `model->DIOrth0` | `params.RTH0` | `dioload.c:584` |
| `Check_th` | `Check_th` | `dioload.c:524` |

## Part D — `CONSTepsSiO2` constant (level=3 prerequisite)

`CONSTepsSiO2` is absent from `src/core/constants.ts`. Add it mirroring
`const.h:46-53`:

```ts
// const.h:44-53 — SiO2 permittivity for level=3 parasitic overlap caps.
//   muZero = 4*pi*1e-7;  epsZero = 1/(muZero*c^2);  epsrSiO2 = 3.9 (all-purpose);
//   epsSiO2 = epsrSiO2 * epsZero  (F/m).
export const CONSTmuZero = 4.0 * Math.PI * 1e-7;            // const.h:44 (H/m)
export const CONSTepsZero = 1.0 / (CONSTmuZero * CONSTc * CONSTc); // const.h:47 (F/m)
export const CONSTepsrSiO2 = 3.9;                          // const.h:51
export const CONSTepsSiO2 = CONSTepsrSiO2 * CONSTepsZero;  // const.h:53 (F/m)
```

(If `CONSTc` is absent, add it from `const.h` — speed of light, `2.99792458e8`.
The implementer verifies which of `CONSTmuZero`/`CONSTepsZero`/`CONSTc` already
exist and adds only the missing ones; the chain must reproduce `const.h`
arithmetic bit-for-bit, so it is defined as the same product, not a precomputed
literal.) `diode.ts` imports `CONSTepsSiO2` from `../../core/constants.js`.

## Part E — `setup()` rebuild: level-3 geometry derivation + thermal TSTALLOC (`diosetup.c:236-349`)

### E.1 — Level-3 model params (added to `DIODE_PARAM_DEFS`)

| ngspice | IOP | digiTS param | default | source |
|---|---|---|---|---|
| `DIOlevel` | `dio.c:48` | `LEVEL` | `1` | `diosetup.c:35-37` |
| `DIOlengthMetal` | `dio.c:125` (`LM`) | `LM` | `0` | `diosetup.c:210-212` |
| `DIOlengthPoly` | `dio.c:126` (`LP`) | `LP` | `0` | `diosetup.c:213-215` |
| `DIOwidthMetal` | `dio.c:127` (`WM`) | `WM` | `0` | `diosetup.c:216-218` |
| `DIOwidthPoly` | `dio.c:128` (`WP`) | `WP` | `0` | `diosetup.c:219-221` |
| `DIOmetalOxideThick` | `dio.c:129` (`XOM`) | `XOM` | `1e-6` | `diosetup.c:222-224` |
| `DIOpolyOxideThick` | `dio.c:130` (`XOI`) | `XOI` | `1e-6` | `diosetup.c:225-227` |
| `DIOmetalMaskOffset` | `dio.c:131` (`XM`) | `XM` | `0` | `diosetup.c:228-230` |
| `DIOpolyMaskOffset` | `dio.c:132` (`XP`) | `XP` | `0` | `diosetup.c:231-233` |

Note the ngspice param NAMES vs struct fields: `XOM`->`DIOmetalOxideThick`,
`XOI`->`DIOpolyOxideThick`, `XM`->`DIOmetalMaskOffset`, `XP`->`DIOpolyMaskOffset`
(`dio.c:129-132`). The instance also carries `W`/`L`/`M`/`PJ` overrides
(`dioparam.c:35-46`): digiTS adds `W`, `L`, `PJ`, `M` instance params if not
already present (`diode.ts:119-124` has `AREA` but not `W/L/M/PJ`).

### E.2 — Area / perimeter / cmetal / cpoly derivation (`diosetup.c:253-291`)

The `scale` is `cp_getvar("scale")` (`diosetup.c:29-30`), defaulting to `1`.
digiTS has no `.options scale` front-end; the implementer sources `scale` from
the engine options context (or `1.0` when absent), citing `diosetup.c:29-30`.
There is NO `ctx.optionScale` field on `LoadContext` (`load-context.ts:59-166`)
or `SetupContext`; `scale` is read from the engine options context where it is
defined, falling back to `1.0` since digiTS exposes no `.options scale` value.

```ts
// diosetup.c:253-291 — area/perimeter from W/L (level=3) and the parasitic
// metal/poly overlap caps. Runs in setup() once per instance.
// scale: from the engine options context, or 1.0 when absent — NOT a
// ctx.optionScale field (no such field exists on the context).
const scale = engineOptionScale ?? 1.0;        // diosetup.c:29-30 cp_getvar("scale")
let area = params.AREA;
let pj = params.PJ;
// diosetup.c:253-258 — m multiplier folds into area & perimeter.
const m = params.M;                            // diosetup.c:253-255 default 1
area = area * m;                               // diosetup.c:257
pj = pj * m;                                   // diosetup.c:258
let cmetal = 0.0, cpoly = 0.0;                 // diosetup.c:259-260
if (params.LEVEL === 3) {
  // diosetup.c:263-266 — when W & L given, derive area & perimeter geometrically.
  if (_wGiven && _lGiven) {
    area = params.W * params.L * m;            // diosetup.c:264
    pj = (2 * params.W + 2 * params.L) * m;    // diosetup.c:265
  }
  area = area * scale * scale;                 // diosetup.c:267
  pj = pj * scale;                             // diosetup.c:268
  // diosetup.c:269-284 — per-dimension instance-vs-model override resolution.
  const wm = _widthMetalGiven  ? params.WM : modelWM;   // here vs model (here is instance-level; both share the param store in digiTS)
  const lm = _lengthMetalGiven ? params.LM : modelLM;
  const wp = _widthPolyGiven   ? params.WP : modelWP;
  const lp = _lengthPolyGiven  ? params.LP : modelLP;
  // diosetup.c:285-290 — parasitic metal & poly overlap caps (CONSTepsSiO2).
  cmetal = CONSTepsSiO2 / params.XOM * m
         * (wm * scale + params.XM)
         * (lm * scale + params.XM);
  cpoly  = CONSTepsSiO2 / params.XOI * m
         * (wp * scale + params.XP)
         * (lp * scale + params.XP);
}
```

**Note on instance-vs-model overrides (`diosetup.c:269-284`):** ngspice resolves
`wm/lm/wp/lp` from the per-INSTANCE param if given (`DIOwidthMetalGiven` etc.)
else the per-MODEL default. digiTS's `PropertyBag` is a single param store per
element (the model params ARE the instance params after merge — `CLAUDE.md`
Component Model Architecture: the element's `model` property is the single
source of truth). So `params.WM` already carries the resolved value; the
instance/model distinction collapses to a single read. The implementer cites
`diosetup.c:269-284` and reads `params.WM/LM/WP/LP` directly. (If digiTS later
separates instance overrides, the givenness flags `_widthMetalGiven` etc. select
the source.)

Because area scaling already happens once at construction (`diode.ts:477-479`:
`params.IS *= AREA` etc.), the implementer must reconcile: the level-3 path
RE-derives `area` from `W*L*m*scale^2`, which then scales `IS`/`CJO`/knee
currents. The cleanest structure (no double-scaling) computes the final `area`
in `setup()`/`computeTemperature` and feeds it to `dioTemp` once, rather than
the construction-time `*= AREA`. The implementer moves area resolution to a
single point (citing `diosetup.c:257-268`) so level-1 (`area = AREA*m`) and
level-3 (`area = W*L*m*scale^2`) both produce one `area` consumed by `dioTemp`.

`area`/`pj` feed `dioTemp` (`DIOtSatCur = IS*area*...`, `diotemp.c:116`;
`DIOtSatSWCur = ISW*pj*...`, `diotemp.c:124`). `cmetal`/`cpoly` are stored on the
element and added to `capd` in `load()` (Part H).

### E.3 — Thermal TSTALLOC (`diosetup.c:341-349`)

The existing 7 junction TSTALLOCs (`diode.ts:580-588`, matching
`diosetup.c:333-339`) are unchanged. When `selfheat`, allocate 7 thermal handles
in the EXACT `diosetup.c:342-348` order (order is parity-sensitive per
`CLAUDE.md` "per-device setup() TSTALLOC sequence"):

```ts
// diosetup.c:341-349 — thermal-node matrix elements, allocated only when
// self-heating is active. Order is load-bearing for matrix element-pool parity.
if (selfheat) {
  _hTempPos      = solver.allocElement(nodeTemp,      nodeAnode);     // diosetup.c:342
  _hTempPosPrime = solver.allocElement(nodeTemp,      _posPrimeNode); // diosetup.c:343
  _hTempNeg      = solver.allocElement(nodeTemp,      nodeCathode);   // diosetup.c:344
  _hTempTemp     = solver.allocElement(nodeTemp,      nodeTemp);      // diosetup.c:345
  _hPosTemp      = solver.allocElement(nodeAnode,     nodeTemp);      // diosetup.c:346
  _hPosPrimeTemp = solver.allocElement(_posPrimeNode, nodeTemp);      // diosetup.c:347
  _hNegTemp      = solver.allocElement(nodeCathode,   nodeTemp);      // diosetup.c:348
}
```

The 7 junction TSTALLOCs run FIRST (`diosetup.c:333-339`), then the 7 thermal
ones (`diosetup.c:342-348`), matching the digiTS handle declaration order. The
internal prime-node creation (`diosetup.c:303-323`) is unchanged
(`diode.ts:573-578`).

## Part F — `dioTemp` recombination + `_dT` derivative outputs (`diotemp.c:143-149`)

`dioTemp` (`diode.ts:275-386`) gains the recombination saturation current and
its temperature derivative, plus the `_dT` fields the self-heating Jacobian
needs. (The full `_dT` production for `tIS`/`tSatSWCur`/`tConductance` is the
`dio#recon/diotempUpdate` recon's body; this recon authors the NEW
recombination producer and the consumption wiring.)

```ts
// diotemp.c:143-149 — recombination saturation current scaling.
//   vtr = NR * vt
//   arg1 = (T/TNOM - 1)*EG/vtr;  arg2 = XTI/NR * log(T/TNOM)
//   DIOtRecSatCur    = ISR * area * exp(arg1+arg2)
//   DIOtRecSatCur_dT = DIOtRecSatCur * (arg1_dT + arg2_dT)
const vtr = p.NR * vt;
const recArg1 = (T / p.TNOM - 1) * p.EG / vtr;
const recArg1_dT = p.EG / (vtr * p.TNOM)
                 - p.EG * (T / p.TNOM - 1) / (vtr * T);   // diotemp.c:144-145
const recArg2 = p.XTI / p.NR * Math.log(T / p.TNOM);      // diotemp.c:146
const recArg2_dT = p.XTI / p.NR / T;                      // diotemp.c:147
const tRecSatCur = p.ISR * area * Math.exp(recArg1 + recArg2);          // diotemp.c:148
const tRecSatCur_dT = tRecSatCur * (recArg1_dT + recArg2_dT);           // diotemp.c:149
```

`DioTempParams` (`diode.ts:225-254`) gains: `tRecSatCur`, `tRecSatCur_dT`,
`tIS_dT`, `tSatSWCur_dT`, `tConductance`, `tConductance_dT`. The `_dT` fields for
`tIS`/`tSatSWCur` follow `diotemp.c:116-117, 124-125` (`* (arg1_dT + arg2_dT)`);
`tConductance_dT` follows `diotemp.c:237-238`. These are produced here and in the
diotempUpdate recon; the consumer is Part C (self-heating Jacobian) and Part G
(recombination current arm).

`dioTemp` also gains the `area`/`pj` arguments (currently it receives pre-scaled
`IS`/`CJO`; the recombination and sidewall scalings need the raw `area`/`pj`
multipliers per `diotemp.c:116,124,148`). The implementer threads `area`/`pj`
(from Part E) into `dioTemp`.

## Part G — Recombination current arm in the forward bottom-current branch (`dioload.c:324-340`)

In `computeDiodeIV` (`diode.ts:397-418`) — or inline in `load()` where the
bottom current is computed — the forward region (`vd >= -3*vte`) gains the
recombination contribution, gated on `DIOrecSatCurGiven`:

```ts
// dioload.c:324-340 — recombination current, gated on DIOrecSatCurGiven.
// Adds a second exponential (emission coeff NR ~ 2) scaled by a generation
// factor that softens the junction-potential dependence.
if (_recSatCurGiven) {
  const vterec = params.NR * vt;                          // dioload.c:325
  const evd_rec = Math.exp(vd / vterec);                  // dioload.c:326
  let cdb_rec = tRecSatCur * (evd_rec - 1);               // dioload.c:327
  let gdb_rec = tRecSatCur * evd_rec / vterec;            // dioload.c:328
  let cdb_rec_dT = tRecSatCur_dT * (evd_rec - 1)
                 - tRecSatCur * vd * evd_rec / (vterec * Temp);  // dioload.c:329-330
  // dioload.c:331-334 — generation factor and its voltage derivative.
  const t1 = Math.pow(1 - vd / tVJ, 2) + 0.005;           // dioload.c:331
  const gen_fac = Math.pow(t1, tGradingCoeff / 2);        // dioload.c:332
  const gen_fac_vd = -tGradingCoeff * (1 - vd / tVJ)
                   * Math.pow(t1, tGradingCoeff / 2 - 1); // dioload.c:333-334
  cdb_rec = cdb_rec * gen_fac;                            // dioload.c:335
  gdb_rec = gdb_rec * gen_fac + cdb_rec * gen_fac_vd;     // dioload.c:336 (cdb_rec already *gen_fac)
  cdb = cdb + cdb_rec;                                    // dioload.c:337
  gdb = gdb + gdb_rec;                                    // dioload.c:338
  cdb_dT = cdb_dT + cdb_rec_dT * gen_fac;                 // dioload.c:339
}
```

**Operand-order note (load-bearing):** `dioload.c:336` reads
`gdb_rec = gdb_rec * gen_fac + cdb_rec * gen_fac_vd` where `cdb_rec` at that
point has ALREADY been multiplied by `gen_fac` on line 335. The TS must mirror
this: line 335 first, then line 336 uses the updated `cdb_rec`. The grading
coefficient is `tGradingCoeff` (`DIOtGradingCoeff`, the temperature-adjusted M,
`diotemp.c:52`) — NOT the raw `params.M`. `tVJ` is `DIOtJctPot`. `Temp` is the
elevated junction temperature from C.3.

| ngspice param | digiTS param | source |
|---|---|---|
| `DIOrecSatCur` (`isr`) | `ISR` | `dio.c:111` |
| `DIOrecEmissionCoeff` (`nr`) | `NR` | `dio.c:112` |
| `DIOtRecSatCur` | `tRecSatCur` | `diotemp.c:148` |
| `DIOtRecSatCur_dT` | `tRecSatCur_dT` | `diotemp.c:149` |
| `DIOrecSatCurGiven` | `_recSatCurGiven` | `diodefs.h:281` |
| `model->DIOrecEmissionCoeff` default `2` | `NR` default `2` | `diosetup.c:182-184` |
| `model->DIOrecSatCur` default `1e-14` | `ISR` default `1e-14` | `diosetup.c:185-187` |

`ISR`/`NR` added to `DIODE_PARAM_DEFS` (`diode.ts:98-118`, secondary group):

```ts
// dio.c:111-112 (DIO_MOD_ISR/NR) — recombination current. diosetup.c:182-187 defaults.
ISR: { default: 1e-14, unit: "A", description: "Recombination saturation current" },
NR:  { default: 2,                description: "Recombination current emission coefficient" },
```

`_recSatCurGiven` mirrors `DIOrecSatCurGiven` (the arm is gated on the param
being explicitly given, NOT on `ISR > 0` — matching the `Given` semantics per
`MEMORY.md` "structural match not semantic"), read from
`props.isModelParamGiven("ISR")`.

## Part H — `cmetal` / `cpoly` fold into `capd` (`dioload.c:455`)

In the charge-storage block (`diode.ts:807-877`), the total capacitance gains
the parasitic overlap caps (`dioload.c:455`):

```ts
// dioload.c:455 — capd = diffcap + deplcap + deplcapSW + DIOcmetal + DIOcpoly.
// cmetal/cpoly are the level-3 parasitic overlap caps from setup() (Part E);
// they are 0 for level=1, so the non-level-3 path is unchanged.
const Ctotal = Cj + Ct + _cmetal + _cpoly;
```

`_cmetal`/`_cpoly` are the closure values from `setup()` (Part E.2), stored as
element fields (mirroring `DIOcmetal`/`DIOcpoly`, `diodefs.h:154-155`). They are
constant per instance (geometry-derived), so they fold into the NIintegrate cap
unchanged each step.

## Part I — AC load thermal branch (`dioacld.c:45-63`)

digiTS's AC path stamps the diode's complex admittance. When `selfheat`, the AC
load gains the same thermal Jacobian (using the stored
`DIOdIth_dVrs`/`dVdio`/`dT`/`gcTt`/`dIrs_dT` from the last DC `load()`) plus the
imaginary thermal-cap term (`dioacld.c:45-63`):

```ts
// dioacld.c:45-63 — AC self-heating thermal branch. Real parts reuse the stored
// dIth_* Jacobian from the DC load; the Tj-Tj imaginary term is cqth*omega.
if (selfheat) {
  // real-part thermal stamps mirror dioload.c:580-588 using stored DIOdIth_*.
  acStamp(_hTempPos,      -dIth_dVrs);                       // dioacld.c:53
  acStamp(_hTempPosPrime, -dIth_dVdio + dIth_dVrs);          // dioacld.c:54
  acStamp(_hTempNeg,       dIth_dVdio);                      // dioacld.c:55
  acStamp(_hTempTemp,     -dIth_dT + 1 / params.RTH0 + gcTt);// dioacld.c:56
  acStampReal(_hPosTemp,       dIrs_dT);                     // dioacld.c:57
  acStampReal(_hPosPrimeTemp,  dIdio_dT - dIrs_dT);          // dioacld.c:58
  acStampReal(_hNegTemp,      -dIdio_dT);                    // dioacld.c:59
  // dioacld.c:61-62 — imaginary Tj-Tj term: cqth (thermal-cap current) * omega.
  // omega is the stampAc(solver, omega, ctx, rhsRe, rhsIm) parameter
  // (element.ts:123-129); there is no ctx.cktOmega field on LoadContext.
  const xgcTt = s0[base + SLOT_CQTH] * omega;
  acStampImag(_hTempTemp, xgcTt);
}
```

The stored Jacobian quantities (`DIOdIth_dVrs` etc., `diodefs.h:147-152`) are
written at the end of the DC `load()` (`dioload.c:552-556`); the implementer
adds element fields `_dIth_dVrs`/`_dIth_dVdio`/`_dIth_dT`/`_gcTt`/`_dIrs_dT`
written there and read in the AC path. `dIdio_dT` for AC is read from
`s0[DIDIO_DT]` (`dioacld.c:52`). The existing junction AC stamps
(`dioacld.c:34-44`) are unchanged.

## Part J — Convergence-test thermal branch (`dioconv.c:41-50`)

digiTS's `checkConvergence` (`diode.ts:880-901`) gains the temperature-prediction
term in `cdhat` (`dioconv.c:41-50`):

```ts
// dioconv.c:41-50 — convergence prediction includes the temperature term.
//   delTemp    = selfheat ? rhsOld[tempNode] : 0
//   deldelTemp = delTemp - state0[DIOdeltemp]
//   cdhat      = state0[DIOcurrent] + state0[DIOconduct]*delvd
//              + state0[DIOdIdio_dT]*deldelTemp
const delTemp = selfheat ? voltages[nodeTemp] : 0.0;        // dioconv.c:42-45
const deldelTemp = delTemp - s0[base + SLOT_DELTEMP];       // dioconv.c:46
const cdhat = id + gd * delvd + s0[base + SLOT_DIDIO_DT] * deldelTemp;  // dioconv.c:48-50
```

The existing `cdhat = id + gd * delvd` (`diode.ts:898`) gains the
`+ s0[DIDIO_DT]*deldelTemp` term; the tolerance test (`diode.ts:899-900`,
`dioconv.c:57-59`) is unchanged.

## Acceptance criteria

1. `buildDiodePinDeclarations()` declares a third pin `Tj` (always present,
   `dio.c:137-143`); `DiodeElement.draw()` paints the `Tj` lead only when the
   resolved `thermal` model param is on (#38 UX gate). `setup()` reads
   `pinNodes.get("Tj")` into `nodeTemp` and computes
   `selfheat = nodeTemp > 0 && THERMAL && _rth0Given` (`diosetup.c:325`).
2. `DIODE_PARAM_DEFS` declares `RTH0` (default `0`, `diosetup.c:204`),
   `CTH0` (default `1e-5`, `diosetup.c:207`), `THERMAL` (flag, default `0`,
   `dioparam.c:47-49`), `ISR` (default `1e-14`, `diosetup.c:186`),
   `NR` (default `2`, `diosetup.c:183`), and the level-3 rows `LEVEL`(1),
   `LM`/`LP`/`WM`/`WP`(0), `XOM`/`XOI`(1e-6), `XM`/`XP`(0) plus instance
   `W`/`L`/`PJ`/`M` (`dio.c:48,122-132`, `diosetup.c:210-233`). `_rth0Given` and
   `_recSatCurGiven` read from `props.isModelParamGiven(...)`.
3. `DIODE_SCHEMA` grows to 9 slots: `QTH`(+5), `CQTH`(+6), `DELTEMP`(+7),
   `DIDIO_DT`(+8) added per `diodefs.h:202-208`; `DIOnumStates=9`.
4. `CONSTepsSiO2 = 3.9 * CONSTepsZero` (with `CONSTepsZero`/`CONSTmuZero`/`CONSTc`
   as needed) is added to `src/core/constants.ts` reproducing `const.h:44-53`
   arithmetic (defined as the product, not a precomputed literal).
5. `setup()` derives `area`/`pj` from `W*L*m*scale^2` for `LEVEL==3`
   (`diosetup.c:263-268`) and `area=AREA*m` otherwise, feeding ONE resolved
   `area`/`pj` to `dioTemp` (no double area-scaling); computes
   `cmetal = epsSiO2/XOM*m*(wm*scale+XM)*(lm*scale+XM)` and the `cpoly`
   counterpart (`diosetup.c:285-290`); `cmetal`/`cpoly` are `0` for `LEVEL!=3`.
   `scale` sourced from the engine option (`diosetup.c:29-30`), defaulting `1`.
6. `setup()` allocates the 7 junction TSTALLOCs (`diosetup.c:333-339`,
   unchanged) and, when `selfheat`, the 7 thermal TSTALLOCs in the EXACT
   `diosetup.c:342-348` order (`TempPos, TempPosPrime, TempNeg, TempTemp,
   PosTemp, PosPrimeTemp, NegTemp`).
7. `dioTemp` returns `tRecSatCur`/`tRecSatCur_dT` (`diotemp.c:148-149`) and the
   `_dT` fields (`tIS_dT`, `tSatSWCur_dT`, `tConductance`, `tConductance_dT`)
   per `diotemp.c:116-117,124-125,237-238`; `area`/`pj` threaded in.
8. `load()` (`dioload.c:80-588`): selects `delTemp` per CKTmode alongside `vd`
   (`dioload.c:135-178`), seeds `DIOqth=CTH0*delTemp` (`dioload.c:178`), damps
   `delTemp` via `limitlog(delTemp, s0[DELTEMP], 100)` when `selfheat`
   (`dioload.c:244-246`, #39), re-evaluates `dioTemp` at `Temp=DIOtemp+delTemp`
   (`dioload.c:254-262`), adds the recombination arm in the forward region
   (`dioload.c:324-340`, gated on `_recSatCurGiven`, with the line-335-before-336
   operand order and `tGradingCoeff`/`tVJ`), integrates the thermal cap via
   `niIntegrate(CTH0, …)` giving `gcTt`/`ceqqth` (`dioload.c:506-514`), computes
   `Ith = vd*cd + vrs^2*gspr` and the full Jacobian (`dioload.c:540-557`), folds
   `cmetal`/`cpoly` into `capd` (`dioload.c:455`), writes the 4 new state slots
   (`dioload.c:529-533`), bumps `noncon` on `Check_th||Check_dio`
   (`dioload.c:523-528`), and emits the 4 thermal RHS + 7 thermal matrix stamps
   (`dioload.c:564-588`). All thermal quantities are `0`/no-op when
   `selfheat` is false, leaving the non-self-heating numerics bit-identical to
   today.
9. AC `load()` adds the thermal real-Jacobian + imaginary `cqth*omega` Tj-Tj
   term when `selfheat` (`dioacld.c:45-63`), reusing the stored
   `DIOdIth_*`/`gcTt`/`dIrs_dT` fields written at the end of DC `load()`.
10. `checkConvergence` adds the `+ s0[DIDIO_DT]*deldelTemp` temperature term to
    `cdhat` (`dioconv.c:48-50`).
11. The `Tj` 3-terminal device, the recombination arm, and the level-3 caps are
    verified on all three surfaces (`CLAUDE.md` three-surface rule): headless
    `DefaultSimulatorFacade`, MCP `circuit_*` netlist round-trip of the 3-pin
    device + `isr`/`nr`/`rth0`/level-3 params, and an E2E `.dig` symbol carrying
    the third pin.
12. With `dio#recon/v41NewFeatures` `APPLIED`, the 31 blocked hunks (next
    section) apply onto the rebuilt baseline as ordinary per-hunk deltas;
    `node spec/v41-port/build-ledger.mjs` re-runs cleanly with the recon
    `APPLIED` and the 31 hunks unblocked.
13. A `.dts`/`.dig` self-heating diode (`rth0`/`cth0`/`thermal=1` with a `Tj`
    node), a recombination diode (`isr=1e-12 nr=2`), and a level-3 diode
    (`level=3` with `w`/`l`/`wm`/`lm`/`xom` etc.) each produce — at every
    accepted NR iteration and timestep — node voltages, the Jacobian matrix
    (including the 7 thermal cells), the per-element state (`DELTEMP`, `QTH`,
    `CQTH`, `DIDIO_DT`), and the matrix shape matching the ngspice DLL. Verified
    via the `harness_*` MCP tool chain (`harness_start` -> `harness_run` ->
    `harness_first_divergence` -> `harness_topology_diff` for the new `Tj` slot
    -> `harness_matrix_diff` for the thermal cells -> `harness_get_attempt`).
    Bit-exact under the matched-arithmetic-order constraint — no tolerance
    qualifier.

## Blocked hunks (apply after the recon)

These 31 v41 hunks are `blockedBy: dio#recon/v41NewFeatures` in `ledger.json`
(the union of the three former `selfHeating`/`recombination`/`level3GeoCap`
recons' blocks per #20, `OPEN-QUESTIONS-WORKLOG.md:327-330`) and apply as
ordinary per-hunk deltas once the baseline above is `APPLIED`:

| Hunk | ngspice anchor | what it adds onto the baseline |
|---|---|---|
| `dio/dioload.c#h002` | `dioload.c` selfheat-local + Check_th init | `selfheat` predicate + `Check_th` setup |
| `dio/dioload.c#h003` | `dioload.c:135-178` | `delTemp` selection per CKTmode + qth seed |
| `dio/dioload.c#h005` | `dioload.c:244-248` | `limitlog` thermal-step damping (#39) |
| `dio/dioload.c#h006` | `dioload.c:254-262` | `DIOtempUpdate` re-eval at `Temp+delTemp` |
| `dio/dioload.c#h007` | `dioload.c:324-340` | recombination current arm + `gen_fac` |
| `dio/dioload.c#h008` | `dioload.c:391` | `dIdio_dT = cdb_dT + cdsw_dT` accumulation |
| `dio/dioload.c#h009` | `dioload.c:455` | `capd += DIOcmetal + DIOcpoly` |
| `dio/dioload.c#h012` | `dioload.c:506-514` | thermal-cap `NIintegrate` (`gcTt`/`ceqqth`) |
| `dio/dioload.c#h017` | `dioload.c:540-557` | `Ith` dissipated power + full thermal Jacobian |
| `dio/dioload.c#h018` | `dioload.c:564-569` | 4 thermal-node RHS loads |
| `dio/dioload.c#h019` | `dioload.c:580-588` | 7 thermal-node matrix stamps |
| `dio/dioload.c#h020` | `dioload.c:523-533` | `Check_th`-merged noncon + 4 new state writes |
| `dio/diosetup.c#h001` | `diosetup.c:182-208` | `isr`/`nr`/`rth0`/`cth0` model defaults |
| `dio/diosetup.c#h004` | `diosetup.c:210-291` | level-3 geometry params + area/perim + cmetal/cpoly |
| `dio/diosetup.c#h005` | `diosetup.c:298` | `*states += DIOnumStates` (9) |
| `dio/diosetup.c#h006` | `diosetup.c:325` | `selfheat` predicate |
| `dio/diosetup.c#h007` | `diosetup.c:341-349` | 7 thermal TSTALLOCs |
| `dio/diodefs.h#h002` | `diodefs.h:41,60-66` | `DIOtempNode` + 7 thermal matrix-ptr fields |
| `dio/diodefs.h#h003` | `diodefs.h:144-155` | `DIOtRecSatCur`/`_dT`, `DIOdIth_*`, `cmetal`/`cpoly` fields |
| `dio/diodefs.h#h005` | `diodefs.h:202-208` | 4 thermal state slots + `DIOnumStates=9` |
| `dio/diodefs.h#h007` | `diodefs.h:284-294` | `rth0`/`cth0`/level-3 given flags |
| `dio/diodefs.h#h008` | `diodefs.h:351-364` (multiblock) | `isr`/`nr`/`rth0`/`cth0`/level-3 model fields |
| `dio/diodefs.h#h009` | `diodefs.h:454-467` (multiblock) | `DIO_MOD_ISR…XP` model-param enum codes |
| `dio/dioparam.c#h002` | `dioparam.c:47-49` | `DIO_THERMAL` flag parse |
| `dio/dioparam.c#h003` | `dioparam.c:69-84` | `DIO_LM/LP/WM/WP` instance-param parse |
| `dio/dio.c#h001` | `dio.c:137-143` | `DIOnames` 3-terminal `{D+,D-,Tj}` |
| `dio/dio.c#h006` | `dio.c:111-132` (multiblock) | `isr`/`nr`/`rth0`/`cth0`/level-3 IOP rows |
| `dio/diompar.c#h001` | `diompar.c` (multiblock) | `isr`/`nr`/`rth0`/`cth0`/level-3 model-param set |
| `dio/dioacld.c#h002` | `dioacld.c:45-63` | AC self-heating thermal branch |
| `dio/dioconv.c#h002` | `dioconv.c:41-50` | convergence temperature-prediction term |
| `dio/dioask.c#h001` | `dioask.c` | `DIO_POWER`/thermal accessor (read-back of `Ith`/`Tj`) |

(The `dioask.c#h001` accessor surfaces `Ith`/`Tj` for query; if digiTS has no
per-device IFparm getter — see #33 cccs precedent — it is NO-COUNTERPART and the
ledger overlay records that. The recon establishes the underlying state it would
read.)

Status: RATIFIED 2026-05-30 (user, batch); REVISED 2026-05-31 (precondition fix, pending re-review)

## As-built triage (2026-06-04)

The "Current digiTS state" notes above are **stale**: the v41-new content is
largely applied in `diode.ts` — the `_dT` temperature derivatives (`tIS_dT`,
`tSatSWCur_dT`, `tTunSatCur_dT`, `tConductance_dT`, …), the recombination
saturation current `tRecSatCur` + its generation-factor scaling, the self-heating
thermal node/state, and the level-3 parasitic geometry (`XOM`/`XOI`,
`DIOcmetal`/`DIOcpoly`) are all present. This recon shares the diode temperature
infrastructure with `dio#recon/diotempUpdate`; the shared engine
temperature-plumbing fix recorded in that spec's triage note
(`CKTContext.setCircuitTempK` keeping `cktTemp`/`loadCtx.temp`/`loadCtx.vt` in
lock-step) makes the temperature-swept diode parity bit-exact. Ledger state is
PENDING; the verify-and-record-APPLIED flip is the port-loop driver's job — do not
hand-edit.
