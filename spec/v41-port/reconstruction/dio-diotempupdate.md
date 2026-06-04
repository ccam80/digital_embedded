# Reconstruction spec — `dio#recon/diotempUpdate`

Rebuild the complete **v26** diode temperature-scaling body — the `tlev`/`tlevc`
branch selection, the `TM1`/`TM2` junction-grading temperature coefficients, the
`TTT1`/`TTT2` transit-time temperature coefficients, the `TRS`/`TRS2`
series-resistance temperature adjust, the tunneling saturation currents
`DIOtTunSatCur`/`DIOtTunSatSWCur`, the `brkdEmissionCoeff` breakdown-current
matching iteration, and the full sidewall depletion-cap path
`tF2SW`/`tF3SW`/`tDepSWCap` — refactored into a `DIOtempUpdate(Temp)` helper that
takes an **explicit temperature** argument; plus the `IS`/`IKF`/`IKR`/`satCur`
`CKTepsmin` floors and the `DIOnomTemp`/`DIOconductance` defaulting that v26
`DIOsetup` applies. The rebuild target is `dioTemp()` /
`DiodeAnalogElement.computeTemperature` / `DiodeAnalogElement.setup` in
`src/components/semiconductors/diode.ts`.

`dio` is an **IN** device class (`device-class-scope.md:46` — currently flagged
"Partial. v41 alignment not yet planned"), so the part of the ngspice diode
temperature/setup model digiTS omits is a **v26-baseline reconstruction** item —
not an accepted divergence and not an open question. The IN-class completeness
rule forbids OMITTING ngspice behavior: the `tlev`/`tlevc` branches, the
`TM1`/`TM2`/`TTT1`/`TTT2`/`TRS`/`TRS2` temperature coefficients, the tunneling
saturation currents, the `brkdEmissionCoeff` breakdown-matching iteration, and the
full sidewall depletion-cap path must all be rebuilt bit-exact.

This spec implements the **RESOLVED** ruling of open question #20
(`Q-DIO-ONE-RECON`), `OPEN-QUESTIONS-WORKLOG.md:83, 313-332`: **HYBRID** — keep
`dio#recon/diotempUpdate` **separate** as the v26-baseline restoration that
**lands first**, so the v41 deltas (self-heating, recombination, level-3 geometry,
the `_dT` self-heating Jacobian derivatives) apply onto a faithful v26 temperature
model. Those v41-new subsystems are owned by the SEPARATE
`dio#recon/v41NewFeatures` recon (`dio-decisions.json:679-687`) and are NOT part of
this recon. The boundary is exact:

- **IN this recon (v26 baseline):** the full `DIOtempUpdate(Temp)` body that
  computes `DIOtJctPot`/`DIOtJctCap`/`DIOtSatCur`/`DIOtSatSWCur`/`DIOtTunSatCur`/
  `DIOtTunSatSWCur`/`DIOtVcrit`/`DIOtBrkdwnV`/`DIOtGradingCoeff`/`DIOtTransitTime`/
  `DIOtConductance`/`DIOtF1`/`DIOtF2`/`DIOtF3`/`DIOtF2SW`/`DIOtF3SW`/`DIOtDepCap`/
  `DIOtDepSWCap` from the explicit `Temp`; the `tlev`/`tlevc` branch selection;
  the `brkdEmissionCoeff` matching iteration; the v26 `DIOsetup` model-default
  block (all the `if(!…Given)` defaults) and the `satCur`/knee `CKTepsmin` floors;
  `DIOnomTemp = CKTnomTemp` and `DIOconductance = 1/DIOresist`.
- **NOT in this recon (`dio#recon/v41NewFeatures`):** the `_dT` temperature
  derivatives (`DIOtSatCur_dT`, `DIOtSatSWCur_dT`, `DIOtTunSatCur_dT`,
  `DIOtTunSatSWCur_dT`, `DIOtRecSatCur_dT`, `DIOtConductance_dT`), the
  recombination saturation current `DIOtRecSatCur` and its scaling, the self-heating
  thermal terminal/state, the level-3 parasitic geometry caps
  (`DIOcmetal`/`DIOcpoly`), and the `cp_getvar("scale")` fold.

Authoring contract: this spec is **documentation**. No code. No tests. The
implementer authors the TypeScript edit against this spec; the verifier checks the
edit against the ngspice citations herein. Per `CLAUDE.md` comment-hygiene: every
reconstructed source comment cites the current
`ref/ngspice/src/spicelib/devices/dio/<file>:line` and explains the mechanism in
present tense, with no `v26`/`v41`/era tags and no migration narrative.

## Current digiTS state

digiTS's `dioTemp()` (`diode.ts:275-386`) implements a **subset** of the v26
`DIOtempUpdate` body. What exists and what is missing:

| ngspice quantity | `diotemp.c` line | digiTS state |
|---|---|---|
| `vt`, `vtnom`, `fact1`, `fact2`, `egfet`/`egfet1`, `pbfact`/`pbfact1` | `:41-77` | Present (`diode.ts:281-298`) |
| `DIOtSatCur` (`tIS`) | `:111-117` | Present (`diode.ts:300-304`), but missing the `DIOactivationEnergy`/`vte` operand layout (uses `EG`/`N*vt` directly) — see Part C |
| `DIOtSatSWCur` (`tSatSWCur`) | `:119-125` | Present (`diode.ts:306-308`) |
| `DIOtJctPot` (`tVJ`), `DIOtJctCap` (`tCJO`) | `:79-93` | Present **but tlevc==0 ONLY** (`diode.ts:310-324`); no `tlevc==1` `DIOtpb`/`DIOcta` branch |
| `DIOtJctSWPot`/`DIOtJctSWCap` | `:95-109` | Present **but tlevc==0 ONLY** + computed from `VJS?`/`MS?` placeholders (`diode.ts:326-340`); no `tlevc==1` `DIOtphp`/`DIOctp` branch |
| `DIOtGradingCoeff` (`TM1`/`TM2`) | `:49-62` | **ABSENT** — digiTS uses raw `params.M` everywhere |
| `DIOtTunSatCur`/`DIOtTunSatSWCur` | `:127-141` | **ABSENT** |
| `DIOtVcrit` | `:165-167` | Present (`diode.ts:342-344`) |
| breakdown `brkdEmissionCoeff` matching iteration | `:188-224` | **WRONG ITERATION** — digiTS runs a Newton solve in `NBV*vt` (`diode.ts:346-359`); ngspice runs the fixed-point `brkdEmissionCoeff` match with the `cbv < tSatCur*tBV/vt` short-circuit, the `DIOtcv`/`tlev` breakdown-voltage temp adjust, and the `level==1 ? m*IBV : IBV*area` cbv selection |
| `DIOtTransitTime` (`TTT1`/`TTT2`) | `:226-229` | **ABSENT** — digiTS uses raw `params.TT` |
| `DIOtConductance` (`TRS`/`TRS2`, area-fold) | `:231-239` | **ABSENT** — digiTS uses `1/params.RS` inline (`diode.ts:786-791`) |
| `DIOtF1`, `DIOtF2`, `DIOtF3`, `DIOtDepCap` | `:156-181, 241-243` | Present (`diode.ts:361-376`) but use raw `M`/`FC`, not `DIOtGradingCoeff` |
| `DIOtF2SW`, `DIOtF3SW`, `DIOtDepSWCap` | `:162-163, 244-246` | **ABSENT (partial sidewall cap)** — only `tJctSWPot`/`tJctSWCap` exist; no F2SW/F3SW/DepSWCap |
| `tlev`/`tlevc` branch selectors | model params | **ABSENT** — no `TLEV`/`TLEVC` params |

digiTS also has no `DIOtempUpdate(Temp)` extraction: `dioTemp(p, T)` already takes
an explicit `T` (`diode.ts:275-280`), which is the correct shape — the refactor
EXTENDS its body and the `DioTempParams` result (`diode.ts:225-254`), it does not
re-introduce a separate function. `computeTemperature` (`diode.ts:949-958`) already
calls `dioTemp` with the resolved `T`; this recon adds the missing branches and
fields to the existing `dioTemp` and grows `DioTempParams` to carry them.

The model-param block missing the v26 defaults: `DIODE_PARAM_DEFS`
(`diode.ts:93-125`) has no `TLEV`/`TLEVC`/`TM1`/`TM2`/`TTT1`/`TTT2`/`TRS`/`TRS2`/
`CTA`/`CTP`/`TPB`/`TPHP`/`TCV`/`JTUN`/`JTUNSW`/`NTUN`/`XTITUN`/`KEG`/`FCS`/`CJSW`/
`VJSW`/`MJSW` rows. The `satCur`/`IKF`/`IKR` `CKTepsmin` floors
(`diosetup.c:92-103, 190-191`) and `DIOconductance` defaulting (`diosetup.c:197-201`)
are absent — digiTS applies area-scaling to `IS`/`CJO` at construction
(`diode.ts:477-479`) and computes `1/RS` inline, with no epsmin floor and no
`given`-flag knee disable.

With this recon `APPLIED`, the **12 blocked v41 hunks** (final section) apply onto
the rebuilt v26 baseline as ordinary per-hunk deltas. Note that several
(`dioload.c#h001/#h011/#h013/#h014/#h015`, `diodefs.h#h004`) are blocked here for
their NON-derivative content only — the `_dT` derivative terms in those hunks are
consumed by `dio#recon/v41NewFeatures`; this recon supplies the baseline quantities
the derivatives differentiate (`tTunSatCur`, the area-folded `tConductance`, the
`KneeCurrentGiven` epsmin-disable defaulting).

## Part A — Model parameters (the v26 temperature-coefficient + tunneling + sidewall card)

ngspice's diode model card carries the temperature-coefficient selectors and
coefficients in `sDIOmodel` (`diodefs.h:296-352`) and the device-parameter enum
(`diodefs.h:400-467`). The reconstruction adds the missing v26 rows to
`DIODE_PARAM_DEFS` (`diode.ts:93-125`), `secondary` group, with their v26
`DIOsetup` defaults (`diosetup.c:107-187`).

| ngspice field | `diodefs.h` line | digiTS param | v26 default | source for default |
|---|---|---|---|---|
| `DIOtlev` | `:321` | `TLEV` | `0` | `diosetup.c:107-109` |
| `DIOtlevc` | `:322` | `TLEVC` | `0` | `diosetup.c:110-112` |
| `DIOgradCoeffTemp1` (TM1) | `:313` | `TM1` | `0.0` | `diosetup.c:59-61` |
| `DIOgradCoeffTemp2` (TM2) | `:314` | `TM2` | `0.0` | `diosetup.c:62-64` |
| `DIOtranTimeTemp1` (TTT1) | `:308` | `TTT1` | `0.0` | `diosetup.c:74-76` |
| `DIOtranTimeTemp2` (TTT2) | `:309` | `TTT2` | `0.0` | `diosetup.c:77-79` |
| `DIOresistTemp1` (TRS) | `:301` | `TRS` | `0.0` | `diosetup.c:137-139` |
| `DIOresistTemp2` (TRS2) | `:302` | `TRS2` | `0.0` | `diosetup.c:140-142` |
| `DIOcta` | `:325` | `CTA` | `0.0` | `diosetup.c:119-121` |
| `DIOctp` | `:326` | `CTP` | `0.0` | `diosetup.c:122-124` |
| `DIOtpb` | `:327` | `TPB` | `0.0` | `diosetup.c:125-127` |
| `DIOtphp` | `:328` | `TPHP` | `0.0` | `diosetup.c:128-130` |
| `DIOtcv` | `:333` | `TCV` | `0.0` | `diosetup.c:143-145` |
| `DIObrkdEmissionCoeff` (NBV) | `:306` | (reuse `NBV`) | `= N` | `diosetup.c:104-106` |
| `DIOtunSatCur` (JTUN) | `:341` | `JTUN` | `0.0` | `diosetup.c:152-154` |
| `DIOtunSatSWCur` (JTUNSW) | `:342` | `JTUNSW` | `0.0` | `diosetup.c:155-157` |
| `DIOtunEmissionCoeff` (NTUN) | `:343` | `NTUN` | `30.0` | `diosetup.c:158-160` |
| `DIOtunSaturationCurrentExp` (XTITUN) | `:344` | `XTITUN` | `3.0` | `diosetup.c:161-163` |
| `DIOtunEGcorrectionFactor` (KEG) | `:345` | `KEG` | `1.0` | `diosetup.c:164-166` |
| `DIOdepletionSWcapCoeff` (FCS) | `:330` | `FCS` | `0.5` | `diosetup.c:68-70` |
| `DIOjunctionSWCap` (CJSW) | `:315` | `CJSW` | `0` | `diosetup.c:83-85` |
| `DIOjunctionSWPot` (VJSW) | `:316` | `VJSW` | `1` | `diosetup.c:86-88` |
| `DIOgradingSWCoeff` (MJSW) | `:317` | `MJSW` | `0.33` | `diosetup.c:89-91` |
| `DIOactivationEnergy` (EG) | `:323` | (reuse `EG`) | `1.11` | `diosetup.c:113-115` |
| `DIOsaturationCurrentExp` (XTI) | `:324` | (reuse `XTI`) | `3` | `diosetup.c:116-118` |

`brkdEmissionCoeff` already lives in digiTS as `NBV` (`diode.ts:107`), defaulting
to `N` (`diode.ts:466`) — this matches `diosetup.c:104-106`
(`if(!DIObrkdEmissionCoeffGiven) DIObrkdEmissionCoeff = DIOemissionCoeff`); KEEP
that mapping (digiTS `NBV` ↔ ngspice `DIObrkdEmissionCoeff`). The sidewall
emission coefficient `NSW`/`DIOswEmissionCoeff` already exists (`diode.ts:117`).
The `CJSW`/`VJSW`/`MJSW` rows REPLACE the current `VJS?`/`MS?` placeholder optionals
in the `dioTemp` signature (`diode.ts:278-279`), which are stand-ins for the real
sidewall card.

### `*Given` guards

The v26 body and the `DIOsetup` defaulting branch on givenness for several
quantities. The reconstruction reads each via `props.isModelParamGiven(...)` in
`createDiodeElement`, mirroring `_tempGiven` (`diode.ts:524`):

| ngspice `*Given` | `diodefs.h` line | digiTS guard | used by |
|---|---|---|---|
| `DIObreakdownVoltageGiven` | `:262` | `isFinite(params.BV)` (existing, `diode.ts:471-474`) | breakdown block gate (`diotemp.c:188`) |
| `DIOresistGiven` | `:232` | `_resistGiven = params.RS !== 0` | TRS adjust gate (`diotemp.c:233`) |
| `DIOforwardKneeCurrentGiven` | `:249` | `_ikfGiven` | epsmin-disable (`diosetup.c:92-97`) |
| `DIOreverseKneeCurrentGiven` | `:250` | `_ikrGiven` | epsmin-disable (`diosetup.c:98-103`) |

`DIObreakdownVoltageGiven` maps to the existing `isFinite(params.BV)` convention
(`diode.ts:471-474`, D-W3-5), which is the digiTS encoding of "BV given". The knee
`*Given` guards are NEW: digiTS today gates IKF/IKR on `isFinite && >0`
(`diode.ts:743, 757`); the v26 setup-defaulting (`diosetup.c:92-103`) clears the
given-flag when the knee is below `CKTepsmin`, which the blocked `dioload.c#h015`
+ `diosetup.c#h002` hunks then read. This recon supplies the `_ikfGiven`/`_ikrGiven`
flags and the epsmin-disable rule.

### `DioTempParams` interface growth

`DioTempParams` (`diode.ts:225-254`) gains the missing v26 outputs:

| field | meaning | `diotemp.c` |
|---|---|---|
| `tGradingCoeff` | `DIOtGradingCoeff` (TM1/TM2-adjusted, gclimit-limited M) | `:52, 57-61` |
| `tTunSatCur` | `DIOtTunSatCur` | `:132` |
| `tTunSatSWCur` | `DIOtTunSatSWCur` | `:140` |
| `tTransitTime` | `DIOtTransitTime` (TTT1/TTT2-adjusted) | `:229` |
| `tConductance` | `DIOtConductance` (TRS/TRS2-adjusted, area-folded) | `:232, 236` |
| `tDepSWCap` | `DIOtDepSWCap` | `:162-163` |
| `tF2SW` | `DIOtF2SW` | `:244` |
| `tF3SW` | `DIOtF3SW` | `:245-246` |

(The `_dT` derivative outputs — `tSatCur_dT` etc. — are NOT added here; they belong
to `dio#recon/v41NewFeatures` per `diodefs.h#h004`/`dioload.c#h001`.)

## Part B — `DIOtempUpdate(Temp)` body: tlev/tlevc, TM1/TM2, junction + sidewall cap

The rebuild extends `dioTemp(p, T)` (`diode.ts:275-386`) to the full v26
`DIOtempUpdate` body (`diotemp.c:18-247`). Identifier mapping:

| ngspice identifier | `diotemp.c` line | digiTS identifier |
|---|---|---|
| `Temp` | `:18` | the `T` argument (`diode.ts:280`) |
| `model->DIOnomTemp` | `:46` | `p.TNOM` |
| `vt = CONSTKoverQ * Temp` | `:41` | `vt = CONSTKoverQ * T` (`diode.ts:281`) |
| `vte = DIOemissionCoeff * vt` | `:42` | `nVt = p.N * vt` |
| `vts = DIOswEmissionCoeff * vt` | `:43` | `vts = p.NSW * vt` |
| `vtt = DIOtunEmissionCoeff * vt` | `:44` | `vtt = p.NTUN * vt` |
| `vtr = DIOrecEmissionCoeff * vt` | `:45` | (recombination — `v41NewFeatures`, omit) |
| `dt = Temp - DIOnomTemp` | `:47` | `dt = T - p.TNOM` |
| `model->DIOgradingCoeff` | `:52` | `p.M` |
| `here->DIOtGradingCoeff` | `:52` | `tGradingCoeff` |
| `model->DIOtlevc` | `:79,89,95,105` | `p.TLEVC` |
| `model->DIOtlev` | `:189` | `p.TLEV` |

### Grading-coefficient temperature adjust + gclimit (`diotemp.c:38-62`)

```ts
// diotemp.c:38-39 — grading-coeff ceiling; cp_getvar DIOgradingCoeffMax defaults 0.9.
// digiTS has no cp_getvar variable store; the ceiling is the fixed 0.9 default.
const gclimit = 0.9;
// diotemp.c:50-52 — TM1/TM2 quadratic temperature adjust of the grading coeff.
const gradFactor = 1.0 + (p.TM1 * dt) + (p.TM2 * dt * dt);
let tGradingCoeff = p.M * gradFactor;
// diotemp.c:57-62 — limit to gclimit (warning suppressed; digiTS has no IFerrorf).
if (tGradingCoeff > gclimit) tGradingCoeff = gclimit;
```

### Junction potential + capacitance, tlevc branch (`diotemp.c:79-93`)

The existing `tlevc==0` arm (`diode.ts:310-324`) is the default path; the rebuild
adds the `tlevc==1` arm and folds `tGradingCoeff` into the cap factor (`diotemp.c`
uses `here->DIOtGradingCoeff`, not raw M, at `:83, 87`):

```ts
let tVJ: number, tCJO: number;
if (p.TLEVC === 0) {
  // diotemp.c:80-88 — pbo/gmaold/gmanew junction-cap temperature scaling.
  const pbo = (p.VJ - pbfact1) / fact1;
  tVJ = pbfact + fact2 * pbo;
  const gmaold = (p.VJ - pbo) / pbo;
  // diotemp.c:82-84 — divide by (1 + tGradingCoeff*(400e-6*(TNOM-REFTEMP) - gmaold)).
  tCJO = p.CJO / (1 + tGradingCoeff * (4e-4 * (p.TNOM - REFTEMP) - gmaold));
  const gmanew = (tVJ - pbo) / pbo;
  // diotemp.c:87-88 — multiply by (1 + tGradingCoeff*(400e-6*(Temp-REFTEMP) - gmanew)).
  tCJO *= 1 + tGradingCoeff * (4e-4 * (T - REFTEMP) - gmanew);
} else {
  // diotemp.c:90-92 — tlevc==1: linear TPB/CTA adjust.
  tVJ = p.VJ - p.TPB * (T - REFTEMP);
  tCJO = p.CJO * (1 + p.CTA * (T - REFTEMP));
}
```

### Sidewall potential + capacitance, tlevc branch (`diotemp.c:95-109`)

```ts
let tJctSWPot: number, tJctSWCap: number;
if (p.TLEVC === 0) {
  // diotemp.c:96-104 — sidewall pbo/gma scaling with MJSW grading coeff.
  const pboSW = (p.VJSW - pbfact1) / fact1;
  tJctSWPot = pbfact + fact2 * pboSW;
  const gmaSWold = (p.VJSW - pboSW) / pboSW;
  tJctSWCap = p.CJSW / (1 + p.MJSW * (4e-4 * (p.TNOM - REFTEMP) - gmaSWold));
  const gmaSWnew = (tJctSWPot - pboSW) / pboSW;
  tJctSWCap *= 1 + p.MJSW * (4e-4 * (T - REFTEMP) - gmaSWnew);
} else {
  // diotemp.c:106-108 — tlevc==1: linear TPHP/CTP adjust.
  tJctSWPot = p.VJSW - p.TPHP * (T - REFTEMP);
  tJctSWCap = p.CJSW * (1 + p.CTP * (T - REFTEMP));
}
```

Note ngspice scales `DIOtJctCap`/`DIOtJctSWCap` from `here->DIOjunctionCap` /
`here->DIOjunctionSWCap` (the area/perimeter-scaled geometry caps,
`diosetup.c:294-295`: `DIOjunctionCap = DIOjunctionCap_model * DIOarea`;
`DIOjunctionSWCap = DIOjunctionSWCap_model * DIOpj`). digiTS area-scales `CJO` at
construction (`diode.ts:479`) and has no perimeter (`pj`) path; the sidewall cap
scales from `CJSW` (perimeter scaling is part of level-3 geometry, owned by
`v41NewFeatures`). For the non-level-3 path `DIOpj` defaults to `model->DIOpj * m`
(`diosetup.c:246-258`), nominally 0 unless `pj=` is netlisted — so `tJctSWCap`
reduces to 0 absent a perimeter, matching the current behavior when `ISW`/`CJSW`
are unset.

## Part C — Saturation currents + tunneling currents (`diotemp.c:111-149`)

ngspice computes `DIOtSatCur`/`DIOtSatSWCur`/`DIOtTunSatCur`/`DIOtTunSatSWCur` with
a shared `arg1 + arg2` exponent layout. The current digiTS `tIS`/`tSatSWCur`
(`diode.ts:300-308`) compute the same value but with a DIFFERENT operand grouping
(`ratio1*EG/(N*vt) + XTI/N*ratlog`). ngspice's layout is the SOURCE OF TRUTH for
bit-exact parity (`diotemp.c:111-116`):

| ngspice | `diotemp.c` line | meaning |
|---|---|---|
| `arg1 = ((Temp/DIOnomTemp)-1)*DIOactivationEnergy/vte` | `:111` | `((T/TNOM)-1)*EG/(N*vt)` |
| `arg2 = DIOsaturationCurrentExp/DIOemissionCoeff*log(Temp/DIOnomTemp)` | `:114` | `XTI/N*log(T/TNOM)` |
| `DIOtSatCur = DIOsatCur*DIOarea*exp(arg1+arg2)` | `:116` | `tIS` |

```ts
// diotemp.c:111-116 — bottom saturation current; vte = N*vt, area folded in IS.
const tArg1 = ((T / p.TNOM) - 1) * p.EG / nVt;
const tArg2 = (p.XTI / p.N) * Math.log(T / p.TNOM);
const tIS = p.IS * Math.exp(tArg1 + tArg2);

// diotemp.c:119-124 — sidewall saturation current; vts = NSW*vt.
const sArg1 = ((T / p.TNOM) - 1) * p.EG / vts;
const sArg2 = (p.XTI / p.NSW) * Math.log(T / p.TNOM);
const tSatSWCur = p.ISW * Math.exp(sArg1 + sArg2);

// diotemp.c:127-133 — tunneling saturation current; vtt = NTUN*vt, KEG*EG numerator.
const uArg1 = ((T / p.TNOM) - 1) * p.KEG * p.EG / vtt;
const uArg2 = (p.XTITUN / p.NTUN) * Math.log(T / p.TNOM);
const tTunSatCur = p.JTUN * Math.exp(uArg1 + uArg2);

// diotemp.c:135-141 — sidewall tunneling saturation current; same arg layout, JTUNSW.
const uwArg1 = ((T / p.TNOM) - 1) * p.KEG * p.EG / vtt;
const uwArg2 = (p.XTITUN / p.NTUN) * Math.log(T / p.TNOM);
const tTunSatSWCur = p.JTUNSW * Math.exp(uwArg1 + uwArg2);
```

`DIOarea`/`DIOpj` are folded into `IS`/`ISW`/`JTUN`/`JTUNSW` — digiTS already
area-scales `IS` at construction (`diode.ts:477`) and feeds `ISW` via `csatsw`
(`diode.ts:702`); `JTUN`/`JTUNSW` get the same area/perimeter treatment when their
load() arms land. The `arg1+arg2` operand grouping replaces the current
`factlog = ratio1*EG/(N*vt) + XTI/N*ratlog` single-expression form (`diode.ts:303`):
mathematically identical, but the rebuild adopts ngspice's split so the
later-landing `_dT` derivatives (`dio#recon/v41NewFeatures`) differentiate the same
operand tree. The recombination current `DIOtRecSatCur` (`diotemp.c:143-149`) is
OMITTED here — it is owned by `v41NewFeatures`.

## Part D — Vcrit, depletion thresholds, F1/F2/F3 + sidewall F2SW/F3SW (`diotemp.c:151-184, 241-246`)

```ts
// diotemp.c:151-152 — xfc/xfcs from the FC/FCS depletion-cap coefficients.
const xfc  = Math.log(1 - p.FC);
const xfcs = Math.log(1 - p.FCS);

// diotemp.c:156-158 — DIOtF1 uses the temperature-adjusted grading coeff.
const tF1 = tVJ * (1 - Math.exp((1 - tGradingCoeff) * xfc)) / (1 - tGradingCoeff);

// diotemp.c:160-163 — depletion-cap thresholds FC*tVJ and FCS*tJctSWPot.
let tDepCap   = p.FC  * tVJ;
let tDepSWCap = p.FCS * tJctSWPot;

// diotemp.c:165-167 — vte recomputed (== N*vt), DIOtVcrit.
const vte = p.N * vt;
const tVcrit = vte * Math.log(vte / (Math.SQRT2 * tIS));
```

`CONSTroot2` in `diotemp.c:167` is √2; digiTS uses `Math.SQRT2` (the existing
`dioTemp` already does, `diode.ts:344`).

Junction-potential ceilings (`diotemp.c:169-184`) — when `tDepCap > 1` clamp `tVJ`
to `1/FC`; when `tDepSWCap > 1` clamp `tJctSWPot` to `1/FCS`:

```ts
// diotemp.c:170-176 — limit junction potential to 1/FC.
if (tDepCap > 1.0) {
  tVJ = 1.0 / p.FC;
  tDepCap = p.FC * tVJ;   // == 1.0
}
// diotemp.c:178-184 — limit sidewall junction potential to 1/FCS.
if (tDepSWCap > 1.0) {
  tJctSWPot = 1.0 / p.FCS;
  tDepSWCap = p.FCS * tJctSWPot;
}
```

F2/F3 + sidewall F2SW/F3SW (`diotemp.c:241-246`) — F2 uses `tGradingCoeff`, F3 uses
raw `FC*(1+tGradingCoeff)`; the sidewall pair uses raw `MJSW`/`FCS`:

```ts
// diotemp.c:241 — DIOtF2 = exp((1+tGradingCoeff)*xfc).
const tF2 = Math.exp((1 + tGradingCoeff) * xfc);
// diotemp.c:242-243 — DIOtF3 = 1 - FC*(1+tGradingCoeff).
const tF3 = 1 - p.FC * (1 + tGradingCoeff);
// diotemp.c:244 — DIOtF2SW = exp((1+MJSW)*xfcs).
const tF2SW = Math.exp((1 + p.MJSW) * xfcs);
// diotemp.c:245-246 — DIOtF3SW = 1 - FCS*(1+MJSW).
const tF3SW = 1 - p.FCS * (1 + p.MJSW);
```

The current `tF2 = Math.pow(1-FC, 1+M)` (`diode.ts:370`) is replaced by the
`exp((1+tGradingCoeff)*xfc)` form, which uses the temperature-adjusted grading
coeff — `Math.pow(1-FC, 1+M)` and `exp((1+M)*log(1-FC))` are the same value at
`TM1=TM2=0`, but ngspice's `exp` form is the source-of-truth operand layout and
`tGradingCoeff` differs from `M` once `TM1`/`TM2` are nonzero.

## Part E — Breakdown voltage matching iteration (`diotemp.c:186-224`)

This REPLACES the digiTS Newton solve (`diode.ts:346-359`). ngspice runs the
`brkdEmissionCoeff` fixed-point match with a `DIOtcv`/`tlev` breakdown-voltage temp
adjust, a `level`-dependent cbv selection, the `cbv < tSatCur*tBV/vt` short-circuit,
and a 25-iteration fixed-point loop. Identifier mapping:

| ngspice | `diotemp.c` line | digiTS |
|---|---|---|
| `model->DIObreakdownVoltageGiven` | `:188` | `isFinite(params.BV)` |
| `model->DIOtcv` | `:190,192` | `p.TCV` |
| `model->DIOtlev` | `:189` | `p.TLEV` |
| `tBreakdownVoltage` | `:190-192` | `tBrkV` |
| `model->DIOlevel` | `:194` | `p.LEVEL` (level-1 path; see note) |
| `here->DIOm` | `:195` | `p.M_MULT` (multiplier; default 1) |
| `model->DIObreakdownCurrent` | `:195,197` | `p.IBV` |
| `model->DIObrkdEmissionCoeff` | `:209,212,215` | `p.NBV` |
| `ckt->CKTreltol` | `:208` | `RELTOL` (engine constant; see note) |
| `here->DIOtBrkdwnV` | `:223` | `tBV` |

```ts
// diotemp.c:186-224 — breakdown voltage temperature adjust + brkdEmissionCoeff match.
let tBV = p.BV;
if (isFinite(p.BV)) {
  // diotemp.c:189-193 — tlev selects subtractive vs multiplicative TCV adjust.
  const tBrkV = p.TLEV === 0
    ? p.BV - p.TCV * dt
    : p.BV * (1 - p.TCV * dt);
  // diotemp.c:194-198 — level==1 uses m*IBV; level==3 uses IBV*area (folded in IBV).
  const cbv = p.IBV;          // digiTS IBV already carries the level/area/m fold
  if (cbv < tIS * tBrkV / vt) {
    // diotemp.c:199-206 — cbv too small to resolve: take tBrkV directly (TRACE warn omitted).
    tBV = tBrkV;
  } else {
    // diotemp.c:208 — match tolerance CKTreltol*cbv.
    const tol = RELTOL * cbv;
    // diotemp.c:209-210 — initial xbv estimate.
    let xbv = tBrkV - p.NBV * vt * Math.log(1 + cbv / tIS);
    // diotemp.c:211-217 — 25-iteration fixed-point match.
    for (let iter = 0; iter < 25; iter++) {
      xbv = tBrkV - p.NBV * vt * Math.log(cbv / tIS + 1 - xbv / vt);
      const xcbv = tIS * (Math.exp((tBrkV - xbv) / (p.NBV * vt)) - 1 + xbv / vt);
      if (Math.abs(xcbv - cbv) <= tol) break;   // diotemp.c:216 goto matched
    }
    tBV = xbv;                                   // diotemp.c:223
  }
}
```

**Note (level/m/cbv):** digiTS has a single-level Shockley diode; `DIOlevel`
(1 vs 3) is a `v41NewFeatures`/level-3 concern. For the v26 level-1 baseline, the
cbv is `m * IBV` (`diotemp.c:195`); digiTS folds `m` (default 1) and area into the
breakdown-current path at the load site. The implementer wires `cbv = p.IBV * m`
with `m` defaulting to 1, matching the level-1 branch; the level-3 `IBV*area`
selection rides with `v41NewFeatures`. `RELTOL` is the engine relative tolerance.
**Precondition correction (RELTOL is NOT reachable in the temperature pass).**
`reltol` exists on `LoadContext` (`load-context.ts:121`, read in `load()` at
`diode.ts:899`) and on `CKTContext` (`ckt-context.ts:65, 444`), but it is NOT on
`TempContext` (`temp-context.ts:15-39`, fields `cktTemp`/`cktNomTemp`/
`_indVerbosity`/`diagnostics?`). `computeTemperature(ctx: TempContext)`
(`diode.ts:949-958`) and the underlying `dioTemp(p, T)` (`diode.ts:275-280`, which
takes only a params object + temperature, no context) therefore have NO access to
`reltol` today. This is NOT an ambiguity — the recon MUST add `reltol` to
`TempContext` and populate it in the lazy `tempCtx` accessor that builds the
context (`ckt-context.ts:349-358`, currently `{cktTemp, cktNomTemp,
_indVerbosity, diagnostics}`). **Touched files:** `temp-context.ts` (add the
`reltol` field) and `ckt-context.ts` (add `reltol: this.reltol` to the `tempCtx`
object literal). `dioTemp` then reads `reltol` from the threaded `TempContext`.

## Part F — Transit time + series-resistance temperature adjust (`diotemp.c:226-239`)

```ts
// diotemp.c:227-229 — transit-time quadratic temperature adjust (TTT1/TTT2).
const ttFactor = 1.0 + (p.TTT1 * dt) + (p.TTT2 * dt * dt);
const tTransitTime = p.TT * ttFactor;

// diotemp.c:232 — series conductance: area-folded base.
//   here->DIOtConductance = model->DIOconductance * here->DIOarea
// digiTS DIOconductance default (diosetup.c:197-201): 0 if RS==0 else 1/RS.
let tConductance = (p.RS !== 0 ? 1 / p.RS : 0) * p.AREA;
// diotemp.c:233-236 — TRS/TRS2 quadratic adjust when resist given and nonzero.
if (p.RS !== 0) {
  const rsFactor = 1.0 + (p.TRS * dt) + (p.TRS2 * dt * dt);
  tConductance = (p.RS !== 0 ? 1 / p.RS : 0) * p.AREA / rsFactor;
}
```

This MOVES the series-resistance handling out of the load `1/params.RS` inline
(`diode.ts:786-791`) into the temperature pass. Currently digiTS area-scales `RS`
at construction (`diode.ts:478`, `RS /= AREA`) and stamps `1/RS` in load(); the v26
model instead carries `DIOtConductance` (an area-scaled, temperature-adjusted
conductance) on the temperature result. The implementer routes the load stamp to
read `tConductance` (the new `DioTempParams` output) instead of computing `1/RS`
inline, so the TRS/TRS2 adjust is applied. The `_dT` conductance derivative
(`DIOtConductance_dT`, `diotemp.c:237-238`) is OMITTED — owned by `v41NewFeatures`
(`diodefs.h#h004`).

## Part G — v26 `DIOsetup` defaulting + CKTepsmin floors (`diosetup.c:35-201`)

The reconstruction adds the v26 model-default block and floors that digiTS omits.
These run at `createDiodeElement` construction (the digiTS `DIOsetup` counterpart),
mirroring the existing `NBV`/`NSW` defaults (`diode.ts:466-469`):

| ngspice default/floor | `diosetup.c` line | digiTS action |
|---|---|---|
| `satCur` `CKTepsmin` floor | `:190-191` | `if (params.IS < CKTepsmin) params.IS = CKTepsmin` — applied AFTER area-scale (`diode.ts:477`) |
| `IKF` epsmin-disable | `:92-97` | `if (_ikfGiven && params.IKF < CKTepsmin) { _ikfGiven = false; }` |
| `IKR` epsmin-disable | `:98-103` | `if (_ikrGiven && params.IKR < CKTepsmin) { _ikrGiven = false; }` |
| `DIOnomTemp = CKTnomTemp` | `:193-195` | `if (!TNOM given) params.TNOM = ctx.cktNomTemp` |
| `DIOconductance` from `DIOresist` | `:197-201` | `params.RS===0 ? conductance=0 : 1/RS` (folded into Part F `tConductance`) |
| `brkdEmissionCoeff = N` | `:104-106` | already present (`diode.ts:466`) |
| `recEmissionCoeff=2`/`recSatCur=1e-14` | `:182-187` | OMIT — recombination is `v41NewFeatures` |

`CKTepsmin` is the engine minimum-conductance/current epsilon (ngspice
`ckt->CKTepsmin`). **Precondition correction (`epsmin`/`CKTepsmin` does NOT exist
in digiTS).** No `epsmin` or `CKTepsmin` field exists anywhere in `src` today — it
is not on `LoadContext`, `TempContext`, `CKTContext`, or `SimulationParams`. The
recon therefore CANNOT read it from any context as written. The value itself is
supplied by `engine#recon/epsmin` (the cross-recon that introduces the ngspice
`CKTepsmin` constant); this recon threads it onto `TempContext` by the SAME
plumbing as `reltol` (Part E): add an `epsmin` field to `TempContext`
(`temp-context.ts:15-39`) and populate it in the lazy `tempCtx` accessor
(`ckt-context.ts:349-358`) from the engine `CKTepsmin` value once `engine#recon/
epsmin` lands. **Touched files:** `temp-context.ts` + `ckt-context.ts` (same two
files as the `reltol` thread). Until `engine#recon/epsmin` lands, the `epsmin`
floors in this Part block on it. The `satCur` floor must run AFTER the construction area-scale so
the floored value matches ngspice (which floors `model->DIOsatCur` before
`DIOtempUpdate` multiplies by `DIOarea`) — the implementer applies the floor to the
model-level `IS` before the `*= AREA` step, matching `diosetup.c:190-191` (which
floors the un-area-scaled model satCur).

The knee `*Given` epsmin-disable (`diosetup.c:92-103`) supplies the
`_ikfGiven`/`_ikrGiven` flags read by the blocked `dioload.c#h015` (the
`DIOforwardKneeCurrentGiven` gate) and `diosetup.c#h002`.

## Part H — Hot-loadability and the `setParam` recompute

All added params are hot-loadable (`MEMORY.md` hot-loadable-params requirement).
`setParam` (`diode.ts:960-975`) already triggers a `computeTemperature` recompute
on any param write; because the new params (`TLEV`/`TLEVC`/`TM1`/`TM2`/`TTT1`/
`TTT2`/`TRS`/`TRS2`/`CTA`/`CTP`/`TPB`/`TPHP`/`TCV`/`JTUN`/`JTUNSW`/`NTUN`/`XTITUN`/
`KEG`/`FCS`/`CJSW`/`VJSW`/`MJSW`) all feed `dioTemp`, the existing recompute path
(`diode.ts:970-972`) carries them with no change beyond passing the new fields into
the `dioTemp` call (`diode.ts:952-957`). The implementer adds the new fields to BOTH
`dioTemp` call sites (the construction pass `diode.ts:512-517` and the
`computeTemperature` pass `diode.ts:952-957`).

## Acceptance criteria

1. `DIODE_PARAM_DEFS` (`diode.ts:93-125`) declares the v26 temperature-coefficient
   + tunneling + sidewall rows of Part A — `TLEV`, `TLEVC`, `TM1`, `TM2`, `TTT1`,
   `TTT2`, `TRS`, `TRS2`, `CTA`, `CTP`, `TPB`, `TPHP`, `TCV`, `JTUN`, `JTUNSW`,
   `NTUN` (default 30), `XTITUN` (default 3), `KEG` (default 1), `FCS` (default 0.5),
   `CJSW` (default 0), `VJSW` (default 1), `MJSW` (default 0.33) — each with its
   `diosetup.c` default and `spiceName`. `NBV`↔`DIObrkdEmissionCoeff` and
   `NSW`↔`DIOswEmissionCoeff` mappings retained.
2. `DioTempParams` (`diode.ts:225-254`) grows the Part-A outputs `tGradingCoeff`,
   `tTunSatCur`, `tTunSatSWCur`, `tTransitTime`, `tConductance`, `tDepSWCap`,
   `tF2SW`, `tF3SW`. No `_dT` derivative fields are added (those are
   `dio#recon/v41NewFeatures`).
3. `dioTemp()` computes the grading-coefficient `TM1`/`TM2` adjust with the `0.9`
   gclimit (Part B), bit-exact against `diotemp.c:38-62`, and uses `tGradingCoeff`
   (not raw `M`) in the cap-factor, `tF1`, `tF2`, `tF3` formulas
   (`diotemp.c:83, 87, 156, 241-243`).
4. `dioTemp()` implements BOTH the `tlevc==0` and `tlevc==1` arms for the junction
   potential/cap (`diotemp.c:79-93`) and the sidewall potential/cap
   (`diotemp.c:95-109`), bit-exact.
5. `dioTemp()` computes `tIS`/`tSatSWCur`/`tTunSatCur`/`tTunSatSWCur` with the
   ngspice `arg1 + arg2` operand layout of `diotemp.c:111-141` (Part C). The
   tunneling currents `DIOtTunSatCur`/`DIOtTunSatSWCur`, ABSENT before, exist.
   The recombination current `DIOtRecSatCur` is NOT computed here.
6. `dioTemp()` computes `tVcrit`, the `tDepCap`/`tDepSWCap` thresholds with their
   `1/FC`/`1/FCS` ceilings, and `tF1`/`tF2`/`tF3`/`tF2SW`/`tF3SW` per
   `diotemp.c:151-184, 241-246` (Part D). `tF2SW`/`tF3SW`/`tDepSWCap`, ABSENT
   before, exist; `tF2` uses the `exp((1+tGradingCoeff)*xfc)` form.
7. The breakdown block (Part E) replaces the Newton solve with the v26
   `brkdEmissionCoeff` fixed-point match including the `tlev`/`DIOtcv` breakdown-V
   temp adjust, the `cbv < tIS*tBrkV/vt` short-circuit, and the 25-iteration loop,
   bit-exact against `diotemp.c:186-224`. The level-1 `cbv = m*IBV` selection is
   used; the level-3 path defers to `v41NewFeatures`.
8. `dioTemp()` computes `tTransitTime` (TTT1/TTT2) and the area-folded,
   TRS/TRS2-adjusted `tConductance` per `diotemp.c:226-236` (Part F); the load
   series-resistance stamp reads `tConductance` instead of inline `1/RS`. The
   `_dT` conductance derivative is NOT computed here.
9. `createDiodeElement`/`setup` applies the v26 `DIOsetup` defaulting + floors of
   Part G: the `satCur` `CKTepsmin` floor (before area-scale), the `IKF`/`IKR`
   epsmin-disable setting `_ikfGiven`/`_ikrGiven` false, `TNOM`←`CKTnomTemp` when
   not given, and the `DIOconductance` rule folded into `tConductance`. The
   recombination/level-3/self-heating defaults are NOT added.
10. All new params are hot-loadable on all three surfaces (headless / MCP / E2E):
    `setParam` of any new param triggers the existing `computeTemperature`
    recompute (Part H), and the next `load()` reads the updated temperature state.
11. With `dio#recon/diotempUpdate` `APPLIED`, the 12 blocked hunks (next section)
    apply onto the rebuilt baseline as ordinary per-hunk deltas.
    `build-ledger.mjs` re-runs cleanly with the recon `APPLIED` and the 12 hunks
    unblocked.
12. A DC-operating-point run on a diode netlisted with non-default temperature
    parameters — at minimum one card exercising `tlevc=1` (`CTA`/`TPB`), one with
    `TM1`/`TM2` grading-temp, one with `TRS`/`TRS2` series-R temp, one with a finite
    `BV`/`IBV` driving the `brkdEmissionCoeff` match, and one with `JTUN`/`NTUN`
    tunneling — at a swept device temperature produces `DIOtJctPot`, `DIOtJctCap`,
    `DIOtSatCur`, `DIOtTunSatCur`, `DIOtBrkdwnV`, `DIOtGradingCoeff`,
    `DIOtTransitTime`, `DIOtConductance`, and the F1/F2/F3/F2SW/F3SW coefficients
    matching the ngspice DLL. Verified via the `harness_*` MCP tool chain
    (`harness_start` → `harness_run` → `harness_first_divergence` →
    `harness_get_attempt`, sliced to the diode component). Bit-exact under the
    matched-arithmetic-order constraint — no tolerance qualifier.

## Blocked hunks (apply after the recon)

These 12 v41 hunks are `blocks: dio#recon/diotempUpdate` in
`planning/dio-decisions.json:663-676` (and `ledger.json`) and apply as ordinary
per-hunk deltas once the v26 baseline above is `APPLIED`:

| Hunk | ngspice anchor | what it adds onto the rebuilt baseline |
|---|---|---|
| `dio/diodefs.h#h004` | `diodefs.h` instance `_dT` fields | the temperature-derivative working fields (`DIOtSatCur_dT`, `DIOtSatSWCur_dT`, `DIOtTunSatCur_dT`, `DIOtTunSatSWCur_dT`, `DIOtConductance_dT`) that extend the rebuilt temp body — derivatives consumed by `dio#recon/v41NewFeatures` |
| `dio/dioload.c#h001` | `dioload.c` load locals | `cdb_dT`/`cdsw_dT` current temperature-derivative locals (the baseline currents they differentiate land here; the derivatives ride with `v41NewFeatures`) |
| `dio/dioload.c#h004` | `dioload.c` instance init | the `gspr = DIOtConductance` relocation (area now folded into `tConductance` by this recon's Part F) |
| `dio/dioload.c#h010` | `dioload.c` `next1:` block | the `DIOtempUpdate(Temp)` re-eval at perturbed `Temp` (this recon's explicit-`Temp` helper is the precondition) + `csat_dT`/`csatsw_dT` (`v41NewFeatures`) |
| `dio/dioload.c#h011` | `dioload.c` sidewall block | the merged `csat_dT += csatsw_dT` (the sidewall baseline currents land here; `_dT` terms `v41NewFeatures`) |
| `dio/dioload.c#h013` | `dioload.c` sidewall tunneling | the sidewall tunneling current (`DIOtTunSatSWCur`, this recon's Part C) + its `cdsw_dT` term |
| `dio/dioload.c#h014` | `dioload.c` bottom tunneling | the bottom tunneling current (`DIOtTunSatCur`, this recon's Part C) + its `cdb_dT` term |
| `dio/dioload.c#h015` | `dioload.c` cd/gd assembly | the `DIOforwardKneeCurrentGiven`/`DIOreverseKneeCurrentGiven` gate change (this recon's Part G supplies the `_ikfGiven`/`_ikrGiven` epsmin-disable defaulting) + `dIdio_dT` (`v41NewFeatures`) |
| `dio/diosetup.c#h002` | `diosetup.c:92-103` | the `IKF`/`IKR` epsmin-disable defaulting (this recon's Part G) |
| `dio/diosetup.c#h003` | `diosetup.c:104-201` | the `satCur` `CKTepsmin` floor, `DIOnomTemp=CKTnomTemp`, `DIOconductance` rule (this recon's Part G); the recombination/self-heating/level-3 defaults in the same hunk ride with `v41NewFeatures` |
| `dio/diotemp.c#h001` | `diotemp.c` function heading | the top-of-function comment dedent (maps to the `dioTemp()` docstring; no behavioral content) |
| `dio/diotemp.c#h002` | `diotemp.c` whole `DIOtempUpdate` | the full `DIOtemp→DIOtempUpdate(model, here, Temp, ckt)` rewrite onto the rebuilt body — the `tlev`/`tlevc` branches, `TM1`/`TM2`, breakdown-match, area-scaled conductance, sidewall `tF2SW`/`tF3SW`/`tDepSWCap` (this recon); the `_dT` derivatives + `tRecSatCur` ride with `v41NewFeatures` |

(The remaining dio hunks — `dioload.c#h002/#h003/#h005-#h009/#h012/#h016-#h019`,
`diosetup.c#h001/#h004-#h009`, `diosload.c#h001`, `diotrunc.c#h001` — are resolved
independently: self-heating/recombination/level-3 block on `dio#recon/v41NewFeatures`,
sensitivity is NO-COUNTERPART, and the cap-gate-mask / lte accessor renames are
ordinary PORT hunks per their `dio-decisions.json` `tsFunction` notes. They do NOT
block on this recon.)

Status: RATIFIED 2026-05-30 (user, batch); REVISED 2026-05-31 (precondition fix, pending re-review)

## As-built triage (2026-06-04)

The "Current digiTS state" table above is **stale**: the recon is largely
applied. `diode.ts` carries the v26 body — the `TLEV`/`TLEVC`/`TM1`/`TM2`/`TTT1`/
`TTT2`/`TRS`/`TRS2`/`CTA`/`CTP`/`TPB`/`TPHP`/`TCV`/`JTUN`/`JTUNSW`/`NTUN`/`XTITUN`/
`KEG`/`FCS`/`CJSW`/`VJSW`/`MJSW` params, both `tlevc==0`/`==1` arms, the `arg1+arg2`
saturation/tunneling layout, `tGradingCoeff`+gclimit, the **v26 `brkdEmissionCoeff`
25-iteration fixed-point breakdown match** (diode.ts:482-501 — the spec's "WRONG
ITERATION" note is stale), the sidewall `tF2SW`/`tF3SW`/`tDepSWCap`, and the
area-folded `tConductance`. **Both preconditions are resolved in code**: `reltol`
AND `epsmin` are threaded onto `TempContext` (temp-context.ts:27,33) and read by
the breakdown match / epsmin floors. `dioTemp()` is self-verified consistent — at
300.15/350/400 K, `gd` at `vd=tVcrit` collapses to exactly `1/√2`.

A real bug surfaced during this triage and was fixed — but it was **NOT** in the
diode model. The `diode-canon-temp-sweep` gate (acceptance #12) was RED at 350/400 K
because `MNAEngine.setCircuitTemp` updated `cktTemp` (so the temperature pass
rescaled `tIS`/`tVcrit`) while leaving the load-context `temp`/`vt` at 300.15 K — so
`dioload`'s `vt = CONSTKoverQ·deviceTemp` ran at the stale reference temperature
against `tIS`/`tVcrit` at the swept temperature, blowing up `gd` at the MODEINITJCT
`vcrit` init. ngspice keeps a single `CKTtemp` read by both passes; the fix
(`CKTContext.setCircuitTempK`, ckt-context.ts) keeps `cktTemp`/`loadCtx.temp`/
`loadCtx.vt` in lock-step. The gate is now bit-exact green at 300.15/350/400 K — so
the diode temperature-scaling itself is correct, and the port-loop's verify pass
should confirm this recon APPLIED. (Ledger state is PENDING; the STALE→APPLIED /
verify-and-record flip is the port-loop driver's job — do not hand-edit.)
