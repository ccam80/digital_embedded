# ngspice alignment — F-MOS: MOSFET + FET base full convergence port

_Extracted from ephemeral tool-results cache. Source agent output verbatim below._

---

I have complete context. Now producing the full audit.

---

# F-MOS: MOSFET Alignment Audit vs ngspice MOS1

**Target ngspice level:** MOS1 (Shichman-Hodges) — confirmed. Our I-V implementation (`mosfet.ts:522-571`) uses the Shichman-Hodges Beta/lambda form, fetlim/limvds/pnjlim gate, Meyer gate capacitances, and area-based junction caps — a one-to-one match to `ref/ngspice/src/spicelib/devices/mos1/mos1load.c`.

**Base class scope:** `src/solver/analog/fet-base.ts` is a **numerical** base class (not a pure helper). It owns NR stamping skeleton, companion-cap integration for cgs/cgd, convergence check (`checkConvergence`, fet-base.ts:399-470), LTE for gate charges (fet-base.ts:642-671), and shared state slots (SLOT_VGS..SLOT_CCAP_SB). JFETs extend the same class (`njfet.ts:130`). Both implications are important: convergence/LTE lives at the base and **must be kept ngspice-accurate for MOSFET specifically** (not JFET-specific); limiting helpers (`fetlim`/`limvds`/`pnjlim`) are in `newton-raphson.ts`, which is correct — they are pure SPICE helpers and both JFET and MOSFET call them independently.

---

## Deliverable 1 — `mos1load.c` section map

| Line range | Section | Purpose |
|---|---|---|
| 25-89 | Declarations | Locals: Beta, sat currents, overlap caps, cdrain, cdreq, conductances, Check, xfact |
| 92-98 | CAPBYPASS init | Sensitivity flag for AC/TRAN sens |
| 100-105 | Model/instance loop | Outer loops |
| 107-108 | Temp + Check init | `vt = CONSTKoverQ*MOS1temp`; `Check = 1` |
| 109-199 | Sensitivity branch | `CKTsenInfo` read; skip to `next1` |
| 129-151 | Pre-crunch | EffectiveLength, DrainSatCur, SourceSatCur, overlap caps, Beta, OxideCap |
| 202-242 | **Voltage source selection** | MODEINITFLOAT\|INITPRED\|INITSMSIG\|INITTRAN path (non-FIXOFF) |
| 205-227 | **PREDICTOR xfact extrapolation** | `xfact = CKTdelta/CKTdeltaOld[1]`, state1→state0 copy of vbs/vgs/vds, `v_new = (1+xfact)*state1 - xfact*state2`, vbd from vbs−vds |
| 229-239 | General iteration | Read `vbs/vgs/vds` from `CKTrhsOld[bNode/gNode/dNodePrime/sNodePrime]` with `MOS1type` polarity |
| 244-277 | Common crunching | vbd, vgd, vgdo, delvbs/delvbd/delvgs/delvds/delvgd, cdhat/cbhat (mode-dependent) |
| 282-347 | **Bypass test (NOBYPASS-gated)** | CKTbypass gate + tolerance windows; restores vbs/vbd/vgs/vds/cdrain/capgs/capgd/capgb from state0, `goto bypass` |
| 354-407 | **Voltage limiting (NODELIMITING-gated)** | `von = MOS1type*MOS1von`; `if vds≥0` ⇒ fetlim vgs(state0_vgs, von)→derive vds→limvds vds(state0_vds)→derive vgd; else fetlim vgd(vgdo, von)→derive vds→**if(!CKTfixLimit)** vds = −limvds(−vds,−state0_vds)→derive vgs. Then `if vds≥0` pnjlim vbs; else pnjlim vbd |
| 412-434 | MODEINITJCT / default init | vbs=−1/vgs=MOS1type*tVto/vds=0 when all ICs are 0, or vbs=vgs=vds=0 |
| 438-445 | Derive vbd/vgd/vgb | From vbs/vgs/vds |
| 448-468 | **Bulk junctions** | `vbs ≤ −3vt`: gbs=CKTgmin, cbs=gbs*vbs−SourceSatCur; else evbs=exp(min(vbs/vt,MAX_EXP_ARG)), gbs=SourceSatCur*evbs/vt+CKTgmin, cbs=SourceSatCur*(evbs−1)+CKTgmin*vbs. Same for vbd |
| 472-478 | **Mode determination** | `MOS1mode = vds≥0 ? 1 : −1` |
| 483-550 | **Shichman-Hodges I-V block** | sarg from tPhi and (mode==1?vbs:vbd) with forward-body-bias branch; von = tVbi*type + gamma*sarg; vgst = (mode==1?vgs:vgd)−von; vdsat = max(vgst,0); arg = gamma/(2*sarg); cutoff/saturation/linear: cdrain, gm, gds, gmbs |
| 557-563 | Post-IV fixup | `MOS1von = type*von`; `MOS1vdsat = type*vdsat`; `MOS1cd = MOS1mode*cdrain − MOS1cbd` |
| 565-694 | **Junction capacitance block** (MODETRAN\|MODETRANOP\|MODEINITSMSIG) | CAPBYPASS-gated; sarg/sargsw with grading MJ/MJSW; `state0[qbs]`, `MOS1capbs`; same for qbd/capbd; linear extension via f2/f3/f4 when vbs/vbd ≥ tDepCap |
| 714-724 | NIintegrate on qbd and qbs | `MOS1gbd += geq; MOS1cbd += state0[cqbd]; MOS1cd -= state0[cqbd]; MOS1gbs += geq; MOS1cbs += state0[cqbs]` |
| 731-743 | **Convergence** | icheck Check==1 ⇒ `CKTnoncon++; CKTtroubleElt = here`, gated by `!off \|\| !(MODEINITFIX\|MODEINITSMSIG)` |
| 750-753 | **State-slot write** (next2) | `state0[vbs/vbd/vgs/vds] = vbs/vbd/vgs/vds` |
| 762-806 | **Meyer gate cap evaluation** (MODETRAN\|MODETRANOP\|MODEINITSMSIG) | DEVqmeyer on (vgs,vgd,vgb) in normal mode or (vgd,vgs,vgb) in reverse; capgs/capgd/capgb = 2*state0[capXX] + overlap for TRANOP\|INITSMSIG, or state0+state1+overlap otherwise |
| 827-855 | **qgs/qgd/qgb state maintenance** | MODEINITPRED\|MODEINITTRAN: xfact-extrapolate state0[qgs/qgd/qgb] from state1/state2; MODETRAN: Q += delV*Cap + state1; TRANOP: Q = V*Cap |
| 858 | bypass: label | NOBYPASS-gated |
| 862-894 | **Meyer-cap NIintegrate** | Zeroed if MODEINITTRAN\|!MODETRAN; otherwise NIintegrate capgs/capgd/capgb with CKTag[0]*qXX addition |
| 902-916 | **Norton currents** | `ceqbs = type*(cbs - gbs*vbs)`; `ceqbd = type*(cbd - gbd*vbd)`; mode-dep `cdreq = ±type*(cdrain - gds*vds - gm*(vgs\|vgd) - gmbs*(vbs\|vbd))` |
| 917-924 | **RHS stamps** | gNode -= type*(ceqgs+ceqgb+ceqgd); bNode -= ceqbs+ceqbd - type*ceqgb; dNodePrime += ceqbd - cdreq + type*ceqgd; sNodePrime += cdreq + ceqbs + type*ceqgs |
| 929-956 | **Y-matrix stamps** | 19 distinct destinations (see below) |

### Enumeration of every numerical apparatus

- **MODEINITJCT** (mos1load.c:419-433): `vds=type*icVDS; vgs=type*icVGS; vbs=type*icVBS`; if all zero and (TRAN\|DCOP\|DCTRANCURVE\|!UIC): `vbs=-1; vgs=type*tVto; vds=0`.
- **MODEINITFIX** (mos1load.c:204): join the MODEINITFLOAT path only if `!here->MOS1off`; otherwise fall through to 412-434 (else branch), which triggers MODEINITJCT priming.
- **MODEINITPRED \| MODEINITTRAN** (mos1load.c:205-227): xfact extrapolation. **Full voltage set copied state1→state0 and extrapolated:** vbs, vgs, vds; vbd is re-derived from state0[vbs]-state0[vds] at 223-225.
- **MODEINITSMSIG** (mos1load.c:202,565,762,789): Triggers MODEINITFLOAT-like voltage read + Meyer cap evaluation + `capgs = 2*state0[capgs] + overlap` (mos1load.c:789-795). Importantly, **MODEINITSMSIG does NOT follow the PREDICTOR branch** — line 206 tests `(MODEINITPRED \| MODEINITTRAN)`, so MODEINITSMSIG goes to general iteration at 229-239.
- **MODEINITFLOAT** (default NR): general iteration via CKTrhsOld, lines 229-239.
- **Non-init NR iteration**: same path as MODEINITFLOAT.
- **DEVfetlim** calls: `vgs = DEVfetlim(vgs, state0[vgs], von)` (forward, mos1load.c:370); `vgd = DEVfetlim(vgd, vgdo, von)` (reverse, mos1load.c:382).
- **DEVlimvds** calls: `vds = DEVlimvds(vds, state0[vds])` (forward, mos1load.c:376); `vds = -DEVlimvds(-vds, -state0[vds])` (reverse, mos1load.c:387) **gated by `if(!(ckt->CKTfixLimit))`** at mos1load.c:385.
- **DEVpnjlim** calls: `vbs = DEVpnjlim(vbs, state0[vbs], vt, sourceVcrit, &Check)` if vds≥0 (mos1load.c:395); `vbd = DEVpnjlim(vbd, state0[vbd], vt, drainVcrit, &Check)` else (mos1load.c:401). Both pass `&Check` — pnjlim sets `*Check = 1` when it limits.
- **Bypass test** (mos1load.c:282-347): NOBYPASS-gated; tempv = max(\|cbhat\|,\|cbs+cbd\|)+CKTabstol; checks reltol on cbhat, delvbs/delvbd/delvgs/delvds against voltTol+reltol*max(V,state0V), and cdhat delta against abstol+reltol*max(cdhat,cd). On hit: restores state0 voltages, computes cdrain from MOS1mode*(cd+cbd), restores capgs/capgd/capgb if in TRAN/TRANOP, sets MOS1cgs/cgd/cgb if sensInfo, jumps to `bypass:`.
- **Convergence/CKTnoncon increment** (mos1load.c:737-743): if `(!off \|\| !(MODEINITFIX\|MODEINITSMSIG))` and `Check==1`: `CKTnoncon++; CKTtroubleElt = (GENinstance*)here`.
- **I-V equation** (mos1load.c:500-546): sarg=sqrt(tPhi-vbx) with forward-body-bias branch at 502-506; von = tVbi*type + gamma*sarg (note: `tVbi` not `tVto`); vgst=(mode==1?vgs:vgd)-von; vdsat=max(vgst,0); arg = gamma/(2*sarg) (else 0 if sarg≤0). Three regions: cutoff→cdrain=0/gm=gds=gmbs=0; saturation (vgst ≤ vds*mode)→cdrain = betap*vgst²/2, gm=betap*vgst, gds=lambda*Beta*vgst²/2, gmbs=gm*arg; linear→cdrain=betap*(vds*mode)*(vgst-0.5*vds*mode), gm=betap*(vds*mode), gds=betap*(vgst-vds*mode)+lambda*Beta*(vds*mode)*(vgst-0.5*vds*mode), gmbs=gm*arg.
- **Charge storage/Meyer model** (mos1load.c:565-694, 762-855): bulk-drain/bulk-source junctions with sarg=(1-vbd/tBulkPot)^(-mj) or linear extension via f2d/f3d/f4d/tDepCap; NIintegrate on (capbd,qbd) and (capbs,qbs) during MODETRAN. Meyer caps via DEVqmeyer with mode-dependent arg order; capgX = 2*state0[capgX]+overlap (TRANOP\|INITSMSIG) or state0+state1+overlap (TRAN), then NIintegrate on (capgs,qgs), (capgd,qgd), (capgb,qgb). Predictor extrapolation of qgs/qgd/qgb at 827-837.
- **Small-signal conductances**: gm, gds, gmbs (from IV block); capbs, capbd (from junction block); capgs, capgd, capgb (from Meyer block).

### Full state-slot layout (mos1defs.h MOS1<name>, zero-based ordinal from model setup)

| Slot | Purpose | Read | Write | Integration |
|---|---|---|---|---|
| MOS1vbs | vbs history | 282, 295, 322, 395 | 211, 750 | No |
| MOS1vbd | vbd history | 298-300, 401 | 223, 751 | No |
| MOS1vgs | vgs history | 248, 303-305, 324, 370 | 215, 752, 786 | No |
| MOS1vds | vds history | 249, 307-309, 325, 368, 376, 387 | 219, 753, 787 | No |
| MOS1capbs | source-bulk cap | — | 633 | No |
| MOS1capbd | drain-bulk cap | — | 688 | No |
| MOS1qbs | source-bulk charge | 331, 724 | 622, 631, 636 | `NIintegrate(capbs,qbs)` → gbs += geq, cbs += state0[cqbs] |
| MOS1cqbs | source-bulk junction companion current | 724 | by NIintegrate | — |
| MOS1qbd | drain-bulk charge | 333, 718 | 676, 686, 691 | `NIintegrate(capbd,qbd)` → gbd += geq, cbd += state0[cqbd], cd -= state0[cqbd] |
| MOS1cqbd | drain-bulk junction companion current | 718 | by NIintegrate | — |
| MOS1qgs | gate-source charge | 830, 841 | 829, 841, 849 | `NIintegrate(capgs,qgs)` then `ceqgs = ceqgs - gcgs*vgs + CKTag[0]*qgs` |
| MOS1cqgs | gate-source companion | 882-889 | by NIintegrate | — |
| MOS1qgd | gate-drain charge | 833, 843 | 832, 843, 850 | Same shape as qgs |
| MOS1cqgd | gate-drain companion | 884-891 | by NIintegrate | — |
| MOS1qgb | gate-bulk charge | 836, 845 | 835, 845, 851 | Same shape as qgs |
| MOS1cqgb | gate-bulk companion | 886-893 | by NIintegrate | — |
| MOS1capgs | Meyer half-cap GS | 331, 775, 797 | written by DEVqmeyer | — |
| MOS1capgd | Meyer half-cap GD | 335, 776, 800 | written by DEVqmeyer | — |
| MOS1capgb | Meyer half-cap GB | 337, 777, 803 | written by DEVqmeyer | — |

### Y-matrix stamp destinations (mos1load.c:929-956)

| Pointer | Expression | Source |
|---|---|---|
| DdPtr | + `drainConductance` | 929 |
| GgPtr | + `(gcgd+gcgs+gcgb)` | 930 |
| SsPtr | + `sourceConductance` | 931 |
| BbPtr | + `(gbd+gbs+gcgb)` | 932 |
| DPdpPtr | + `drainConductance+gds+gbd+xrev*(gm+gmbs)+gcgd` | 933-935 |
| SPspPtr | + `sourceConductance+gds+gbs+xnrm*(gm+gmbs)+gcgs` | 936-938 |
| DdpPtr | − `drainConductance` | 939 |
| GbPtr | − `gcgb` | 940 |
| GdpPtr | − `gcgd` | 941 |
| GspPtr | − `gcgs` | 942 |
| SspPtr | − `sourceConductance` | 943 |
| BgPtr | − `gcgb` | 944 |
| BdpPtr | − `gbd` | 945 |
| BspPtr | − `gbs` | 946 |
| DPdPtr | − `drainConductance` | 947 |
| DPgPtr | + `((xnrm-xrev)*gm-gcgd)` | 948 |
| DPbPtr | + `(-gbd+(xnrm-xrev)*gmbs)` | 949 |
| DPspPtr | + `(-gds-xnrm*(gm+gmbs))` | 950-951 |
| SPgPtr | + `(-(xnrm-xrev)*gm-gcgs)` | 952 |
| SPsPtr | − `sourceConductance` | 953 |
| SPbPtr | + `(-gbs-(xnrm-xrev)*gmbs)` | 954 |
| SPdpPtr | + `(-gds-xrev*(gm+gmbs))` | 955-956 |

---

## Deliverable 2 — Current state of our MOSFET + FET base

### Base class `src/solver/analog/fet-base.ts`

- **State slots** (fet-base.ts:49-100): 45 slots. Matches ngspice shape for MOS1 except: ngspice has separate `MOS1capbs/capbd` for depletion cap (not companion); ours has `SLOT_CAP_GEQ_DB/SB` (companion conductance) + separate `Q_DB/Q_SB`. Essentially equivalent encoding.
- **`load()`** (fet-base.ts:253-266): 3-phase order — `_updateOp`→`_stampLinear`+`_stampNonlinear`→`_stampCompanion`+`_stampReactiveCompanion` if reactive+transient. **Divergence from ngspice**: ngspice mos1load.c is a single linear pass; our split into update/stamp works because we compute the same operating point, but **`_updateOp` does not read ctx to branch on MODEINITPRED** — it only checks `initMode==="initPred"` in the MOSFET override. The base `_updateOp` at fet-base.ts:339-366 has no predictor path, so JFETs and the default MOSFET inherit **zero xfact extrapolation**.
- **`checkConvergence`** (fet-base.ts:399-470): Recomputes cdhat/cbhat per mos1conv.c:36-76. **Correct algebraically** but uses `storedVbs = -SLOT_VSB` (fet-base.ts:427). This is a **DIVERGENCE** — ngspice reads `vbs` from `CKTrhs` (post-NR) directly; we read from state0 via SLOT_VSB which was written in `_updateOp` after limiting. mos1conv.c uses `CKTrhs` (post-solve) — ours pulls from node voltages in checkConvergence (fet-base.ts:420), which is the post-solve iterate, matching ngspice. But `storedVbs = -SLOT_VSB` uses the pre-solve stored value, matching mos1conv.c:49 which uses `state0[vbs]`. OK.
- **`_stampCompanion`** (fet-base.ts:472-561): Handles GS/GD only — integrates cgs/cgd via `niIntegrate`. **Zeroes cgs/cgd when `isFirstCall === MODEINITTRAN`** (fet-base.ts:553-560). Matches mos1load.c:862-873.

### MOSFET subclass `src/components/semiconductors/mosfet.ts`

- **State**: uses base schema + adds no new slots.
- **Convergence apparatus**:
  - `limitVoltages` (mosfet.ts:722-750) — implements mos1load.c:360-407 **without `CKTfixLimit` gate**. **DIVERGENCE**: line 743 always executes `-limvds(-vds,-vdsOld)` in reverse mode. mos1load.c:385 gates this on `!CKTfixLimit`.
  - Bulk pnjlim (mosfet.ts:1371-1405): matches mos1load.c:393-405 shape. Uses `VT` (300.15K = 0.02585V) as the thermal voltage — **DIVERGENCE**: mos1load.c:107 uses `vt = CONSTKoverQ * here->MOS1temp`, per-instance. Our code hard-codes global VT, ignoring `this._tPhi`'s temperature.
  - `pnjLimited` → `ctx.noncon.value++` at mosfet.ts:1444 — matches ngspice icheck at mos1load.c:739-742.
- **I-V equation** (mosfet.ts:522-571): **DIVERGENCE from mos1load.c:507** — ngspice computes `von = tVbi*type + gamma*sarg`; ours computes `vth = tVto + gamma*(sarg - sqrt(phi))` at mosfet.ts:544. Algebraically, `tVbi = tVto - type*gamma*sqrt(tPhi) + temp_corrections`; these collapse to the same `von` only when `tVbi == tVto - type*gamma*sqrt(tPhi)` exactly. `_tVbi` at mosfet.ts:1025 adds `+ 0.5*(egfet1-egfet) + type*0.5*(tPhi-p.PHI)`, which is the temperature correction. So `tVto + gamma*(sarg-sqrt(phi))` ≠ `tVbi*type + gamma*sarg` — the first form has an implicit `type` applied differently. This is a **real numerical divergence**: for NMOS (type=+1), `tVbi = tVto - gamma*sqrt(tPhi)`, so `tVbi*type + gamma*sarg = tVto - gamma*sqrt(tPhi) + gamma*sarg = tVto + gamma*(sarg-sqrt(tPhi))`. These ARE equal for NMOS. For PMOS, polarity is already applied via `this.polaritySign` in upstream code — so the `tVbi*type` factor matters. In our code PMOS uses `_tVto = _tVbi + (-1)*gamma*sqrt(tPhi)`, then `vth = _tVto + gamma*(sarg - sqrt(tPhi))`. In ngspice, `von = tVbi*(-1) + gamma*sarg`. Expand: `ours_vth = _tVbi - gamma*sqrt(tPhi) + gamma*sarg - gamma*sqrt(tPhi) = _tVbi + gamma*sarg - 2*gamma*sqrt(tPhi)`. **Not equal to ngspice's `-tVbi + gamma*sarg`.** PMOS VTO computation is buggy when gamma > 0. (Our resolveParams takes `Math.abs(p.VTO)` at mosfet.ts:973 for PMOS, so VTO is positive magnitude.)
  - Actually revisiting: ngspice's `MOS1type = -1` for PMOS. mos1temp.c:175-176: `tVto = tVbi + type * gamma * sqrt(tPhi)`, so for PMOS `tVto = tVbi - gamma*sqrt(tPhi)` ⇒ `tVbi = tVto + gamma*sqrt(tPhi)`. ngspice's `von = tVbi*(-1) + gamma*sarg = -tVto - gamma*sqrt(tPhi) + gamma*sarg`. Ours: `vth = tVto + gamma*(sarg - sqrt(tPhi))` with tVto being magnitude via `VTO = abs(VTO)` = `|tVto| + gamma*sarg - gamma*sqrt(tPhi)`. **Sign of tVto differs**: ngspice carries signed tVto (negative for PMOS), ours uses magnitude. PMOS path is then handled by the caller's polarity flip: `vgs_for_IV = polaritySign * (vG - vS)` makes it positive-convention for PMOS; so |VTO| as threshold on that polarity-flipped vgs IS correct. The von derivation matches **only because** the polarity is flipped at the top. Tentatively OK, but the `von` slot written for Meyer gate cap (mosfet.ts:1360 `SLOT_VON = result.vth`) is stored in device-polarity-normalized form, not ngspice's `MOS1type*von`. mos1load.c:557 explicitly writes `MOS1von = type*von`. If any consumer reads SLOT_VON in raw-node polarity, mismatch.
- **Meyer gate cap** (mosfet.ts:1176-1213, 1745-1776): Follows mos1load.c:773-805 structure but **diverges in averaging semantics**. ngspice uses `capgs = state0[capgs] + state1[capgs] + overlap` for MODETRAN (current-cycle half-cap already in state0, previous-cycle half-cap in state1). Our code at mosfet.ts:1210 does `meyerGs + prevMeyerGs + overlap` — same shape. ngspice at 789-795 uses `capgs = 2*state0[capgs] + overlap` for TRANOP/INITSMSIG; our MODEINITSMSIG branch is absent — we use `2*meyerGs` when `_ctxInitMode === "initTran"` at mosfet.ts:1210, which is **MODEINITTRAN not MODETRANOP/MODEINITSMSIG**. ngspice's MODEINITTRAN path at mos1load.c:797-805 uses `state0 + state1 + overlap`, NOT `2*state0 + overlap`. **DIVERGENCE**: our first-TRAN step uses `2*capgs` where ngspice uses `state0+state1` (with state1 being whatever cold-start DCOP left there). This is wrong.
- **Predictor xfact extrapolation**: `_updateOp` (mosfet.ts:1226-1235) under `initMode === "initPred"` does `state0[SLOT_VGS] = state1[SLOT_VGS]`, same for VDS/VBS_OLD/VBD_OLD. **DIVERGENCE (critical)**: (a) no xfact computation from `ctx.deltaOld`; (b) no `(1+xfact)*state1 - xfact*state2` application to produce the actual `vgs`/`vds`/`vbs`/`vbd` used for device evaluation; (c) the code then falls through to read node voltages at 1294-1307, which is the **general iteration path** — so the predictor-copied state0 voltages are immediately overwritten by the normal NR iterate. The predictor step is **a no-op that pretends to copy state but has zero effect on the voltages used for linearization**. Additionally: no extrapolation of qgs/qgd/qgb per mos1load.c:827-837.
- **MODEINITSMSIG branch**: No code path for `initMode === "initSmsig"` in mosfet.ts. **MISSING**.
- **Stamping**: `_stampNonlinear` at mosfet.ts:1447-1528 — stamps gm/gds/gmbs, bulk-drain and bulk-source junction conductances. **DIVERGENCE: does not use the ngspice mos1load.c:917-956 formulation literally.** Specifically:
  - ngspice stamps `DPdpPtr += drainConductance + gds + gbd + xrev*(gm+gmbs) + gcgd` — single destination combining drain conductance, channel conductance, junction conductance, transconductance contribution, AND companion cap conductance.
  - Ours stamps these separately: channel gm/gds in one block (mosfet.ts:1458-1475), bulk gm/gds in another (mosfet.ts:1505-1516), reactive companion in `_stampReactiveCompanion`. Algebraically equivalent because stamping is additive, **but the ordering of the `xrev*(gm+gmbs)` term** depends on swap detection, and I've verified the effective stamp at `DPdpPtr` in reverse mode includes gm+gmbs only at DPdpPtr (when swapped, the "drain" role is taken by physical source). Our code re-routes via effectiveD/effectiveS — algebraically the same, but without xnrm/xrev explicit the **Norton RHS direction for reverse mode** is a separate concern (see next point).
  - Norton RHS: ngspice mos1load.c:913-916 `cdreq = -type*(cdrain - gds*(-vds) - gm*vgd - gmbs*vbd)` for reverse mode. Ours at mosfet.ts:1491 multiplies by `-polarity` which has same effect as `-type`. OK, but the sign of `-gds*(-vds) = +gds*vds` is preserved only when our `this._vds` is the original Vds (positive-convention). When reverse, `this._vds < 0` and our Norton uses `-this._vds` on gds term. Let me recheck mosfet.ts:1491: `-polarity * (this._ids - this._gds * (-this._vds) - this._gm * vgd - this._gmbs * vbd)`. ngspice: `cdreq = -type*(cdrain - gds*(-vds) - gm*vgd - gmbs*vbd)`. Matches.
- **Temperature model** (mos1temp.c) (mosfet.ts:993-1079): Follows mos1temp.c:44-200 structure. **DIVERGENCE**: `fact2 = REFTEMP/REFTEMP = 1` (mosfet.ts:1009) — hardcoded. mos1temp.c:137 sets `fact2 = MOS1temp/REFTEMP` using the **per-instance** MOS1temp (ckt->CKTtemp + MOS1dtemp). Our model assumes circuit temperature = REFTEMP always. Also `this._tSatCur = p.IS * tempFactor` (mosfet.ts:1032) — ngspice: `MOS1tSatCur = model->MOS1jctSatCur * exp(-egfet/vt + egfet1/vtnom)` (mos1temp.c:177-178). Same. And our `_tCbd = p.CBD * capfact` applies TWO capfact mults (mosfet.ts:1039 then mosfet.ts:1047). mos1temp.c:185 then mos1temp.c:195 does the same sequence. OK.
- **Bypass test**: **MISSING ENTIRELY**. mos1load.c:282-347 bypass block has no equivalent in our MOSFET.
- **Junction diode GMIN conductance**: Our `gbs = sourceSatCur * evbs / VT + GMIN` at mosfet.ts:1423 — matches mos1load.c:458 `gbs = SourceSatCur*evbs/vt + CKTgmin`. ngspice uses per-instance `vt`; ours uses global VT. **DIVERGENCE** under temperature sweeps.
- **`MAX_EXP_ARG`**: Ours uses 709.78 (mosfet.ts:1264, 1414); ngspice uses `MAX_EXP_ARG` from `ngspice/trandefs.h` — typically 709 (approximately). Close enough.
- **sarg forward-body-bias branch** (mosfet.ts:538-541, mos1load.c:502-505): Matches.
- **Charge/junction cap f2/f3/f4 linearization** (mosfet.ts:1085-1141): Follows mos1temp.c:218-289 shape. **DIVERGENCE**: mos1temp.c:238-242 formula is `f2d = czbd*(1-fc*(1+mj)) * sarg/arg + czbdsw*(1-fc*(1+mjsw)) * sargsw/arg`. Ours at mosfet.ts:1110-1111 matches. But mos1load.c:686-687 uses `qbd = f4d + vbd*(f2d + vbd*f3d/2)` (note `*f3d/2`, not `f3d/2`). Ours at mosfet.ts:1691 uses `f4d + vbd * (f2d + vbd * f3d / 2)` — same precedence, OK.

---

## Deliverable 3 — Concrete diffs at the FET base class

The base class contains numerical apparatus (`_updateOp`, `_stampCompanion`, `checkConvergence`, `getLteTimestep`). Those ARE ngspice-aligned for the shared JFET+MOSFET operations. The MOSFET-specific pieces (xfact extrapolation of qbs/qgb/vbd, Meyer cap averaging, bypass) are correctly in the MOSFET subclass (where subclass overrides `_updateOp` and `_stampCompanion`).

### Diff B-1 — Base `_updateOp` must NOT swallow the predictor branch for MOSFETs

The base `_updateOp` at fet-base.ts:339-366 has no predictor path. This forces every subclass to override `_updateOp` (MOSFET does at mosfet.ts:1219). For JFET parity (F5-ext scope), this is fine — JFET inherits the non-predictor path and F5-ext handles predictor separately. **No change needed at the base**; the MOSFET subclass must implement predictor correctly (Deliverable 4).

### Diff B-2 — `_pnjlimLimited` scope

The base uses `this._pnjlimLimited` (fet-base.ts:191) and increments `ctx.noncon` at 360. The MOSFET subclass also increments `ctx.noncon` at mosfet.ts:1444 based on the same flag. **The MOSFET path double-counts** — when MOSFET's `_updateOp` runs, its code sets `this._pnjlimLimited` and calls `ctx.noncon.value++`. The base `_updateOp` is overridden (not called via super), so this is actually fine — but it's fragile. No change required, but flag for F5-ext coordination: if the base ever calls `super._updateOp(ctx)` the increment would double.

### Diff B-3 — Base `checkConvergence` uses `reltol` but omits `voltTol`

fet-base.ts:467: `reltol * max(|cdhat|,|cdFinal|) + abstol`. mos1conv.c:80-89 uses `CKTreltol` and `CKTabstol` (the absolute current tol). ngspice has no `voltTol` term here. Ours matches. **No change needed.**

### Diff B-4 — `getLteTimestep` at base (fet-base.ts:642-671) only handles gate charges qgs/qgd

mos1trun.c (ngspice truncation) includes qbs/qbd and qgb. The base only handles qgs/qgd; MOSFET subclass overrides at mosfet.ts:1929-1958 to add qgb but NOT qbs/qbd. **DIVERGENCE**: our MOSFET LTE ignores bulk-junction charges.

**OLD** (`src/components/semiconductors/mosfet.ts:1929-1958`):
```typescript
override getLteTimestep(
  dt: number,
  deltaOld: readonly number[],
  order: number,
  method: IntegrationMethod,
  lteParams: import("../../solver/analog/ckt-terr.js").LteParams,
): number {
  // GS + GD from base class
  let minDt = super.getLteTimestep(dt, deltaOld, order, method, lteParams);

  const base = this.stateBaseOffset;
  const s0 = this._s0;
  const s1 = this.s1;
  const s2 = this.s2;
  const s3 = this.s3;

  // Gate-bulk
  {
    const ccap0 = s0[base + SLOT_CCAP_GB];
    const ccap1 = s1[base + SLOT_CCAP_GB];
    const q0 = s0[base + SLOT_Q_GB];
    const q1 = s1[base + SLOT_Q_GB];
    const q2 = s2[base + SLOT_Q_GB];
    const q3 = s3[base + SLOT_Q_GB];
    const dtGB = cktTerr(dt, deltaOld, order, method, q0, q1, q2, q3, ccap0, ccap1, lteParams);
    if (dtGB < minDt) minDt = dtGB;
  }

  return minDt;
}
```
**NEW**:
```typescript
override getLteTimestep(
  dt: number,
  deltaOld: readonly number[],
  order: number,
  method: IntegrationMethod,
  lteParams: import("../../solver/analog/ckt-terr.js").LteParams,
): number {
  // GS + GD from base class
  let minDt = super.getLteTimestep(dt, deltaOld, order, method, lteParams);

  const base = this.stateBaseOffset;
  const s0 = this._s0;
  const s1 = this.s1;
  const s2 = this.s2;
  const s3 = this.s3;

  // ngspice mos1trun.c calls CKTterr on qgs, qgd, qgb, qbs, qbd.
  // Gate-bulk, drain-bulk junction, source-bulk junction charges.
  for (const slotQ of [SLOT_Q_GB, SLOT_Q_DB, SLOT_Q_SB] as const) {
    const ccapSlot = slotQ === SLOT_Q_GB ? SLOT_CCAP_GB
                   : slotQ === SLOT_Q_DB ? SLOT_CCAP_DB
                   : SLOT_CCAP_SB;
    const ccap0 = s0[base + ccapSlot];
    const ccap1 = s1[base + ccapSlot];
    const q0 = s0[base + slotQ];
    const q1 = s1[base + slotQ];
    const q2 = s2[base + slotQ];
    const q3 = s3[base + slotQ];
    const dtX = cktTerr(dt, deltaOld, order, method, q0, q1, q2, q3, ccap0, ccap1, lteParams);
    if (dtX < minDt) minDt = dtX;
  }

  return minDt;
}
```
ngspice citation: `ref/ngspice/src/spicelib/devices/mos1/mos1trun.c` (all MOS1-charge terms qgs/qgd/qgb/qbs/qbd fed to CKTterr; same idiom as bjt1trun.c).

### Diff B-5 — SLOT_VON init should not be NaN

fet-base.ts:131: `{ name: "VON", ..., init: { kind: "constant", value: NaN } }`. This forces MOSFET to check `isNaN(storedVon)` at mosfet.ts:1153. ngspice's MOS1von is zero-initialized by model setup (mos1set.c zero-fills the struct). Matching ngspice means init to 0.

**OLD** (`src/solver/analog/fet-base.ts:131`):
```typescript
  { name: "VON",       doc: "Previous threshold voltage (for fetlim von)",       init: { kind: "constant", value: NaN } },
```
**NEW**:
```typescript
  { name: "VON",       doc: "Previous threshold voltage (for fetlim von)",       init: { kind: "zero" } },
```
And `mosfet.ts:1153` becomes `const von = storedVon;` (always use stored). ngspice citation: `ref/ngspice/src/spicelib/devices/mos1/mos1set.c` — MOS1von defaults to 0 via calloc-zeroed instance struct. mos1load.c:356 reads `von = model->MOS1type * here->MOS1von` with no NaN guard.

### No base class coupling to JFET work

`fetlim`/`limvds`/`pnjlim` already live in `newton-raphson.ts` (pure SPICE helpers) — not in the base class. Base class overrides are generic enough that F5-ext's JFET predictor work won't clash with our MOSFET predictor fix.

---

## Deliverable 4 — Concrete diffs for `mosfet.ts` subclass

### Diff M-1 — **CRITICAL: MODEINITPRED / MODEINITTRAN xfact extrapolation (voltage states)**

**OLD** (`src/components/semiconductors/mosfet.ts:1226-1236`):
```typescript
  private _updateOpImpl(voltages: Readonly<Float64Array>, limitingCollector: LimitingEvent[] | null, ctx: LoadContext): void {
    if (ctx.initMode === "initPred") {
      // mos1load.c:206-225: copy voltage-old references for fetlim/pnjlim limiting
      const base = this.stateBaseOffset;
      const s0 = this._s0;
      const s1 = this.s1;
      s0[base + SLOT_VGS]     = s1[base + SLOT_VGS];      // fetlim vold for vgs
      s0[base + SLOT_VDS]     = s1[base + SLOT_VDS];      // limvds vold for vds
      s0[base + SLOT_VBS_OLD] = s1[base + SLOT_VBS_OLD];  // pnjlim vold for vbs
      s0[base + SLOT_VBD_OLD] = s1[base + SLOT_VBD_OLD];  // pnjlim vold for vbd
    }
```
**NEW**:
```typescript
  private _updateOpImpl(voltages: Readonly<Float64Array>, limitingCollector: LimitingEvent[] | null, ctx: LoadContext): void {
    // ngspice mos1load.c:205-227 — MODEINITPRED | MODEINITTRAN predictor.
    // xfact = CKTdelta / CKTdeltaOld[1].
    // state0[vbs] = state1[vbs];  vbs = (1+xfact)*state1[vbs] - xfact*state2[vbs]
    // same for vgs, vds.  Then state0[vbd] = state0[vbs] - state0[vds].
    if (ctx.initMode === "initPred" || ctx.initMode === "initTran") {
      const base = this.stateBaseOffset;
      const s0 = this._s0;
      const s1 = this.s1;
      const s2 = this.s2;
      const deltaOld = ctx.deltaOld;
      // ngspice uses CKTdeltaOld[1] as denominator. Our unified deltaOld[1] is
      // the previous-accepted timestep. Guard for degenerate zero.
      const xfact = deltaOld[1] > 0 ? ctx.dt / deltaOld[1] : 0;

      // vbs
      s0[base + SLOT_VBS_OLD] = s1[base + SLOT_VBS_OLD];
      const vbsPred = (1 + xfact) * s1[base + SLOT_VBS_OLD] - xfact * s2[base + SLOT_VBS_OLD];
      // vgs
      s0[base + SLOT_VGS] = s1[base + SLOT_VGS];
      const vgsPred = (1 + xfact) * s1[base + SLOT_VGS] - xfact * s2[base + SLOT_VGS];
      // vds
      s0[base + SLOT_VDS] = s1[base + SLOT_VDS];
      const vdsPred = (1 + xfact) * s1[base + SLOT_VDS] - xfact * s2[base + SLOT_VDS];
      // vbd derived from state0[vbs] - state0[vds] (mos1load.c:223-225)
      s0[base + SLOT_VBD_OLD] = s0[base + SLOT_VBS_OLD] - s0[base + SLOT_VDS];

      // Write extrapolated values into the fields used for IV evaluation.
      // These are the `vgs`, `vds`, `vbs`, `vbd` in mos1load.c after the
      // predictor block exits — the device linearizes around these.
      this._vgs = vgsPred;
      this._vds = vdsPred;
      this._vsb = -vbsPred;            // vbs = -vsb
      this._swapped = vdsPred < 0;
      const vbdPred = vbsPred - vdsPred;
      // Feed IV eval directly: skip the general iteration node-voltage read.
      this._ctxInitMode = ctx.initMode;
      s0[base + SLOT_MODE] = vdsPred >= 0 ? 1 : -1;
      s0[base + SLOT_VBS_OLD] = vbsPred;
      s0[base + SLOT_VBD_OLD] = vbdPred;

      // Evaluate I-V at the extrapolated operating point
      const result = computeIds(vgsPred, vdsPred, -vbsPred, this._p);
      this._ids = result.ids;
      this._lastVdsat = result.vdsat;
      this._gm = computeGm(vgsPred, vdsPred, -vbsPred, this._p);
      this._gds = computeGds(vgsPred, vdsPred, -vbsPred, this._p);
      this._gmbs = computeGmbs(vgsPred, vdsPred, -vbsPred, this._p);
      s0[base + SLOT_VON] = result.vth;

      // Bulk junction diodes at extrapolated vbs, vbd
      const drainSatCur = this._drainSatCur;
      const sourceSatCur = this._sourceSatCur;
      const MAX_EXP_ARG = 709.78;
      let gbs: number, cbsI: number;
      if (vbsPred <= -3 * VT) {
        gbs = GMIN;
        cbsI = GMIN * vbsPred - sourceSatCur;
      } else {
        const evbs = Math.exp(Math.min(vbsPred / VT, MAX_EXP_ARG));
        gbs = sourceSatCur * evbs / VT + GMIN;
        cbsI = sourceSatCur * (evbs - 1) + GMIN * vbsPred;
      }
      let gbd: number, cbdI: number;
      if (vbdPred <= -3 * VT) {
        gbd = GMIN;
        cbdI = GMIN * vbdPred - drainSatCur;
      } else {
        const evbd = Math.exp(Math.min(vbdPred / VT, MAX_EXP_ARG));
        gbd = drainSatCur * evbd / VT + GMIN;
        cbdI = drainSatCur * (evbd - 1) + GMIN * vbdPred;
      }
      s0[base + SLOT_GBD] = gbd;
      s0[base + SLOT_GBS] = gbs;
      s0[base + SLOT_CBD_I] = cbdI;
      s0[base + SLOT_CBS_I] = cbsI;
      s0[base + SLOT_VBD] = vbdPred;
      return;
    }
```
ngspice citation: `mos1load.c:205-227`, `mos1load.c:438-468`.

### Diff M-2 — **MODEINITSMSIG branch**

**OLD**: no code path; falls through to general iteration.

**NEW** (insert after the `initJct` block and before the generic node-voltage read in `_updateOpImpl`, `src/components/semiconductors/mosfet.ts:~1293`):
```typescript
    // ngspice mos1load.c:202 — MODEINITSMSIG joins the MODEINITFLOAT voltage
    // read path (non-PREDICTOR), then at mos1load.c:789-795 forces
    // capgs = 2*state0[capgs] + overlap for Meyer-cap linearization.
    // The distinguishing behavior lives entirely in _stampCompanion; here we
    // simply ensure the mode flag is routed so the companion stamp picks the
    // right averaging. No state-slot mutation beyond the standard general
    // iteration is required.
    if (ctx.initMode === "initSmsig") {
      // Mark _ctxInitMode so _stampCompanion / computeCapacitances select
      // the TRANOP|INITSMSIG averaging: capgX = 2*state0[capgX] + overlap.
      this._ctxInitMode = "initSmsig";
    }
```
And in `computeCapacitances` at mosfet.ts:1210, change the averaging gate:
```typescript
      // OLD:
      const firstTran = this._ctxInitMode === "initTran";
      const cgs = (firstTran ? 2 * meyerGs : meyerGs + prevMeyerGs) + gsOverlap;
      const cgd = (firstTran ? 2 * meyerGd : meyerGd + prevMeyerGd) + gdOverlap;
      // NEW:
      // ngspice mos1load.c:789-795: 2*state0[capgX]+overlap under MODETRANOP|MODEINITSMSIG.
      // MODETRAN (the normal transient path) uses state0[capgX]+state1[capgX]+overlap.
      // Our tranStep===0 covers the MODETRANOP cold-start case; initSmsig is the
      // small-signal AC linearization trigger.
      const useDouble = this._ctxInitMode === "initSmsig" || this._pool.tranStep === 0;
      const cgs = (useDouble ? 2 * meyerGs : meyerGs + prevMeyerGs) + gsOverlap;
      const cgd = (useDouble ? 2 * meyerGd : meyerGd + prevMeyerGd) + gdOverlap;
```
ngspice citation: `mos1load.c:789-795`, `mos1load.c:202`.

### Diff M-3 — **MODEINITJCT alignment: honor `off` flag and `IC` values with correct fallback**

Our `primeJunctions` at mosfet.ts:1615-1631 and the `initJct` branch at mosfet.ts:1241-1292 partially implement this. **DIVERGENCE**: mos1load.c:419-433 reads `type*icVDS, type*icVGS, type*icVBS` from the model if any are non-zero, and applies the MOS1type sign. Our `primeJunctions` hardcodes `_vgs = _tVto; _vds = 0; vbs = -1` for the `off==0` case — matches the fallback (mos1load.c:427-429) but **does not honor user-supplied `IC_VDS`/`IC_VGS`/`IC_VBS` when they are non-zero**. And `primeJunctions` is called from `dcopModeLadder.runPrimeJunctions`, not from `_updateOp` — so if `initMode === "initJct"` is ever reached without the ladder having called prime, `_vgs/_vds/_vsb` are stale.

**OLD** (`src/components/semiconductors/mosfet.ts:1615-1631`):
```typescript
  primeJunctions(): void {
    if (this._p.OFF) {
      this._vgs = 0;
      this._vds = 0;
      const base = this.stateBaseOffset;
      this._s0[base + SLOT_VBS_OLD] = 0;
      this._s0[base + SLOT_VBD_OLD] = 0;
      this._vsb = 0;
    } else {
      this._vgs = this._tVto;
      this._vds = 0;
      const base = this.stateBaseOffset;
      this._s0[base + SLOT_VBS_OLD] = -1;
      this._s0[base + SLOT_VBD_OLD] = -1;
      this._vsb = 1;
    }
  }
```
**NEW**:
```typescript
  primeJunctions(): void {
    // ngspice mos1load.c:419-433: MODEINITJCT branch.
    //   if !off:
    //     vds = type*icVDS; vgs = type*icVGS; vbs = type*icVBS;
    //     if all three ICs==0 && (MODETRAN|MODEDCOP|MODEDCTRANCURVE|!MODEUIC):
    //       vbs=-1; vgs=type*tVto; vds=0;
    //   else (off): vbs=vgs=vds=0
    const base = this.stateBaseOffset;
    const s0 = this._s0;
    const type = this.polaritySign;
    const icVDS = (this._p as ResolvedMosfetParams & { ICVDS?: number }).ICVDS ?? 0;
    const icVGS = (this._p as ResolvedMosfetParams & { ICVGS?: number }).ICVGS ?? 0;
    const icVBS = (this._p as ResolvedMosfetParams & { ICVBS?: number }).ICVBS ?? 0;

    if (this._p.OFF) {
      this._vgs = 0;
      this._vds = 0;
      s0[base + SLOT_VBS_OLD] = 0;
      s0[base + SLOT_VBD_OLD] = 0;
      this._vsb = 0;
      return;
    }

    let vds = type * icVDS;
    let vgs = type * icVGS;
    let vbs = type * icVBS;
    if (vds === 0 && vgs === 0 && vbs === 0) {
      // Default prime when no ICs (mos1load.c:427-429)
      vbs = -1;
      vgs = type * this._tVto;
      vds = 0;
    }
    this._vgs = vgs;
    this._vds = vds;
    s0[base + SLOT_VBS_OLD] = vbs;
    s0[base + SLOT_VBD_OLD] = vbs - vds;
    this._vsb = -vbs;
  }
```
This also requires adding `ICVDS`, `ICVGS`, `ICVBS` to MosfetParams (mosfet.ts:114-163). ngspice citation: `mos1load.c:419-433`.

### Diff M-4 — **Bypass test** (mos1load.c:282-347)

**OLD**: absent.

**NEW** — insert in `_updateOpImpl` after the node-voltage read (mosfet.ts:~1307) and after delvgs/delvds deltas are available, before limiting:
```typescript
    // mos1load.c:282-347 — NOBYPASS-gated bypass test. When device state has
    // barely changed since last iteration, reuse last iteration's values.
    const base = this.stateBaseOffset;
    const s0 = this._s0;
    const reltol = ctx.reltol;
    const iabstol = ctx.iabstol;
    const voltTol = (ctx as LoadContext & { voltTol?: number }).voltTol ?? iabstol;
    // MOSFET linearization cached from last iteration
    const gm_cached = s0[base + SLOT_GM];
    const gds_cached = s0[base + SLOT_GDS];
    const gmbs_cached = s0[base + SLOT_GMBS];
    const gbd_cached = s0[base + SLOT_GBD];
    const gbs_cached = s0[base + SLOT_GBS];
    const cbd_cached = s0[base + SLOT_CBD_I];
    const cbs_cached = s0[base + SLOT_CBS_I];
    const ids_cached = s0[base + SLOT_IDS];
    const mode_cached = s0[base + SLOT_MODE];
    const storedVgs = s0[base + SLOT_VGS];
    const storedVds = s0[base + SLOT_VDS];
    const storedVbs = s0[base + SLOT_VBS_OLD];
    const storedVbd = s0[base + SLOT_VBD_OLD];
    const storedVgd = storedVgs - storedVds;

    const vGsProposed = vGraw;
    const vDsProposed = vDraw;
    const vGdProposed = vGsProposed - vDsProposed;
    const vBsProposed = -vBraw;
    const vBdProposed = vBsProposed - vDsProposed;

    const delvgs = vGsProposed - storedVgs;
    const delvds = vDsProposed - storedVds;
    const delvgd = vGdProposed - storedVgd;
    const delvbs = vBsProposed - storedVbs;
    const delvbd = vBdProposed - storedVbd;

    let cdhat: number, cbhat: number;
    if (mode_cached >= 0) {
      cdhat = (mode_cached * ids_cached - cbd_cached)
            - gbd_cached * delvbd
            + gmbs_cached * delvbs
            + gm_cached * delvgs
            + gds_cached * delvds;
    } else {
      cdhat = (mode_cached * ids_cached - cbd_cached)
            - (gbd_cached - gmbs_cached) * delvbd
            - gm_cached * delvgd
            + gds_cached * delvds;
    }
    cbhat = cbs_cached + cbd_cached + gbd_cached * delvbd + gbs_cached * delvbs;

    const tempv = Math.max(Math.abs(cbhat), Math.abs(cbs_cached + cbd_cached)) + iabstol;
    const canBypass =
      !(ctx.initMode === "initPred" || ctx.initMode === "initTran" || ctx.initMode === "initSmsig") &&
      ctx.iteration > 0 &&
      Math.abs(cbhat - (cbs_cached + cbd_cached)) < reltol * tempv &&
      Math.abs(delvbs) < reltol * Math.max(Math.abs(vBsProposed), Math.abs(storedVbs)) + voltTol &&
      Math.abs(delvbd) < reltol * Math.max(Math.abs(vBdProposed), Math.abs(storedVbd)) + voltTol &&
      Math.abs(delvgs) < reltol * Math.max(Math.abs(vGsProposed), Math.abs(storedVgs)) + voltTol &&
      Math.abs(delvds) < reltol * Math.max(Math.abs(vDsProposed), Math.abs(storedVds)) + voltTol &&
      Math.abs(cdhat - (mode_cached * ids_cached - cbd_cached)) <
        reltol * Math.max(Math.abs(cdhat), Math.abs(mode_cached * ids_cached - cbd_cached)) + iabstol;

    if (canBypass) {
      // Restore state0 voltages and linearization — nothing else changes
      this._vgs = storedVgs;
      this._vds = storedVds;
      this._vsb = -storedVbs;
      this._swapped = mode_cached < 0;
      // IV linearization already in state0 — no recomputation needed.
      // Skip limiting, junction eval, charge eval. _stampNonlinear will read
      // the cached values and emit the same stamps as last iteration.
      return;
    }
```
ngspice citation: `mos1load.c:282-347`.

### Diff M-5 — **CKTfixLimit gate on reverse-`limvds`**

**OLD** (`src/components/semiconductors/mosfet.ts:722-750`):
```typescript
export function limitVoltages(
  vgsOld: number,
  vgsNew: number,
  vdsOld: number,
  vdsNew: number,
  von: number,
): { vgs: number; vds: number; swapped: boolean } {
  let vgs = vgsNew;
  let vds = vdsNew;
  const vgd = vgs - vds;
  const vgdOld = vgsOld - vdsOld;

  if (vdsOld >= 0) {
    // Forward: fetlim vgs, derive vds, limvds, derive vgd
    vgs = fetlim(vgs, vgsOld, von);
    vds = vgs - vgd;
    vds = limvds(vds, vdsOld);
  } else {
    // Reverse: fetlim vgd, derive vds, -limvds(-vds,-vdsOld), derive vgs
    const vgdLim = fetlim(vgd, vgdOld, von);
    vds = vgs - vgdLim;
    vds = -limvds(-vds, -vdsOld);
    vgs = vgdLim + vds;
  }

  const swapped = vds < 0;
  return { vgs, vds, swapped };
}
```
**NEW**:
```typescript
export function limitVoltages(
  vgsOld: number,
  vgsNew: number,
  vdsOld: number,
  vdsNew: number,
  von: number,
  cktFixLimit: boolean,
): { vgs: number; vds: number; swapped: boolean } {
  let vgs = vgsNew;
  let vds = vdsNew;
  const vgd = vgs - vds;
  const vgdOld = vgsOld - vdsOld;

  if (vdsOld >= 0) {
    // mos1load.c:368-379 forward path
    vgs = fetlim(vgs, vgsOld, von);
    vds = vgs - vgd;
    vds = limvds(vds, vdsOld);
    const vgdCurrent = vgs - vds;
    // vgd = vgs - vds already consistent
    void vgdCurrent;
  } else {
    // mos1load.c:380-391 reverse path
    const vgdLim = fetlim(vgd, vgdOld, von);
    vds = vgs - vgdLim;
    // mos1load.c:385: `if(!(ckt->CKTfixLimit))`
    if (!cktFixLimit) {
      vds = -limvds(-vds, -vdsOld);
    }
    vgs = vgdLim + vds;
  }

  const swapped = vds < 0;
  return { vgs, vds, swapped };
}
```
And threading at mosfet.ts:1310 and in the class method at mosfet.ts:1143:
```typescript
  limitVoltages(
    vgsOld: number,
    _vdsOld: number,
    vgsNew: number,
    vdsNew: number,
  ): { vgs: number; vds: number; swapped: boolean } {
    const base = this.stateBaseOffset;
    const storedVon = this._s0[base + SLOT_VON];
    const von = storedVon;  // after Diff B-5, this is always valid
    // cktFixLimit threaded through LoadContext (Deliverable 5)
    return limitVoltages(vgsOld, vgsNew, _vdsOld, vdsNew, von, this._cktFixLimit);
  }
```
With `_cktFixLimit` stashed on the instance via `_updateOpImpl(... ctx)`:
```typescript
    this._cktFixLimit = ctx.cktFixLimit;
```
ngspice citation: `mos1load.c:385`.

### Diff M-6 — **icheck Check aggregation at the Norton/noncon step**

mos1load.c:737-743: `if ((off==0) || !(MODEINITFIX|MODEINITSMSIG)) { if (Check == 1) { CKTnoncon++; CKTtroubleElt = here; } }`. The `Check` flag is set by DEVpnjlim (pointer arg) when its vbs or vbd limit fires.

**OLD** (`src/components/semiconductors/mosfet.ts:1444`):
```typescript
    if (this._pnjlimLimited) ctx.noncon.value++;
```
**NEW**:
```typescript
    // ngspice mos1load.c:737-743 — icheck gate: skip the increment if
    // (off && (MODEINITFIX|MODEINITSMSIG)).  Otherwise increment whenever
    // the pnjlim limiter fired (Check == 1).
    const suppressNoncon = this._p.OFF &&
      (ctx.initMode === "initFix" || ctx.initMode === "initSmsig");
    if (this._pnjlimLimited && !suppressNoncon) {
      ctx.noncon.value++;
    }
```
And fetlim/limvds should also set Check in ngspice (they do not — only pnjlim does per devsup.c). Verified: only pnjlim writes to `Check`. Current code is correct here, only the gate semantics matter. ngspice citation: `mos1load.c:737-743`.

### Diff M-7 — **qgs/qgd/qgb xfact extrapolation** (mos1load.c:827-837)

**OLD**: `_stampCompanion` (mosfet.ts:1633-1786) computes the Meyer half-caps and integrates; no predictor-extrapolation branch for qgs/qgd/qgb.

**NEW** — add at the top of `_stampCompanion` (after the base class call, before the junction cap block):
```typescript
    // ngspice mos1load.c:827-837 — MODEINITPRED | MODEINITTRAN predictor
    // extrapolates Meyer charges qgs, qgd, qgb:
    //   state0[qgX] = (1+xfact)*state1[qgX] - xfact*state2[qgX]
    // The companion integrator below then uses these state0 values.
    if (this._ctxInitMode === "initPred" || this._ctxInitMode === "initTran") {
      const base = this.stateBaseOffset;
      const s0 = this._s0;
      const s1 = this.s1;
      const s2 = this.s2;
      const xfact = deltaOld[1] > 0 ? dt / deltaOld[1] : 0;
      // Q_GS and Q_GD are in the base schema (SLOT_Q_GS=32, SLOT_Q_GD=33)
      s0[base + 32] = (1 + xfact) * s1[base + 32] - xfact * s2[base + 32];
      s0[base + 33] = (1 + xfact) * s1[base + 33] - xfact * s2[base + 33];
      // Q_GB is subclass-level
      s0[base + SLOT_Q_GB] = (1 + xfact) * s1[base + SLOT_Q_GB] - xfact * s2[base + SLOT_Q_GB];
    }
```
(Preferably use named constants `SLOT_Q_GS`, `SLOT_Q_GD` imported from `fet-base.ts`.) ngspice citation: `mos1load.c:827-837`.

### Diff M-8 — **Shichman-Hodges `von` formula** — verify ngspice parity

**OLD** (`src/components/semiconductors/mosfet.ts:543-547`):
```typescript
  const vth = tVto !== undefined
    ? tVto + p.GAMMA * (sarg - Math.sqrt(phi))
    : p.VTO + p.GAMMA * (sarg - Math.sqrt(phi));
  const von = vth;
```
**NEW**:
```typescript
  // ngspice mos1load.c:507 — `von = tVbi*type + gamma*sarg`.
  // Our caller applies polarity by flipping vgs/vds before this function,
  // so we evaluate with positive-convention Vto == |Vto|. Algebraically,
  // tVbi = tVto - type*gamma*sqrt(tPhi), so
  //   von = (tVto - type*gamma*sqrt(tPhi))*type + gamma*sarg
  //       = type*tVto - gamma*sqrt(tPhi) + gamma*sarg
  //       = type*tVto + gamma*(sarg - sqrt(tPhi))
  // With our convention type==+1 for the positive-convention Vto-magnitude
  // the caller passes, this reduces to:
  //       = tVto + gamma*(sarg - sqrt(tPhi))
  // which matches the current formula for NMOS. For PMOS the caller
  // flips the IV polarity upstream, so the magnitude form remains
  // correct provided VTO is stored as |VTO| (mosfet.ts:973).
  // No change to the expression — but VERIFY: SLOT_VON must be written
  // in positive-convention (matches tVto-mag); callers (Meyer cap) must
  // not apply an additional polarity flip.
  const vth = tVto !== undefined
    ? tVto + p.GAMMA * (sarg - Math.sqrt(phi))
    : p.VTO + p.GAMMA * (sarg - Math.sqrt(phi));
  const von = vth;
```
**This is already algebraically correct for our polarity convention.** No edit needed; adding a comment explaining why is the only change.

### Diff M-9 — **Per-instance `vt` for bulk-junction eval** (mos1load.c:107)

**OLD** (`src/components/semiconductors/mosfet.ts:1418-1436`):
```typescript
    const MAX_EXP_ARG = 709.78;
    if (vbs <= -3 * VT) {
      gbs = GMIN;
      cbsI = GMIN * vbs - sourceSatCur;
    } else {
      const evbs = Math.exp(Math.min(vbs / VT, MAX_EXP_ARG));
      gbs = sourceSatCur * evbs / VT + GMIN;
      cbsI = sourceSatCur * (evbs - 1) + GMIN * vbs;
    }
```
**NEW**:
```typescript
    // ngspice mos1load.c:107: `vt = CONSTKoverQ * here->MOS1temp` (per-instance
    // device temperature). Our _updateTempParams fixes MOS1temp == REFTEMP,
    // so instanceVt == REFTEMP*KoverQ. When device temperature sweeps are
    // introduced this must be re-derived from here->MOS1temp.
    const instanceVt = REFTEMP * KoverQ;  // matches mos1load.c:107 under T=REFTEMP
    const MAX_EXP_ARG = 709.78;
    if (vbs <= -3 * instanceVt) {
      gbs = GMIN;
      cbsI = GMIN * vbs - sourceSatCur;
    } else {
      const evbs = Math.exp(Math.min(vbs / instanceVt, MAX_EXP_ARG));
      gbs = sourceSatCur * evbs / instanceVt + GMIN;
      cbsI = sourceSatCur * (evbs - 1) + GMIN * vbs;
    }
```
Same pattern for the vbd branch at mosfet.ts:1429-1436 and for the `initJct` branch at mosfet.ts:1266-1284. ngspice citation: `mos1load.c:107, 453-468`.

### Diff M-10 — **`_tCbs` second-pass capfact bug** at mos1temp.c:196

mos1temp.c:195-197:
```c
here->MOS1tCbd *= capfact;
here->MOS1tCbs *= capfact;
here->MOS1tCj *= capfact;
```
Ours (mosfet.ts:1047-1049): matches.

mos1temp.c:198-200:
```c
capfact = (1+model->MOS1bulkJctSideGradingCoeff*
        (4e-4*(here->MOS1temp-REFTEMP)-gmanew));
here->MOS1tCjsw *= capfact;
```
Ours (mosfet.ts:1050-1051): `capfact = 1 + p.MJSW * (4e-4 * (REFTEMP - REFTEMP) - gmanew); this._tCjsw *= capfact;`. With REFTEMP-REFTEMP = 0, this reduces to `capfact = 1 - p.MJSW*gmanew` — matches ngspice when `here->MOS1temp = REFTEMP`. OK for our fixed-temperature case. **DIVERGENCE when temperature is swept** (tracked as part of Diff M-9).

### Diff M-11 — **Stamp geometry for `_stampNonlinear`**

Verified the stamp geometry is algebraically equivalent to mos1load.c:929-956. **No diff needed.** The single potential issue is the bulk RHS: `stampRHS(solver, nodeB, polarity * (ceqbd + ceqbs))` (mosfet.ts:1526) matches ngspice mos1load.c:919 `bNode -= (ceqbs + ceqbd - type*ceqgb)`. Our code omits the `-type*ceqgb` term in `_stampNonlinear` (correct — that term is stamped in `_stampReactiveCompanion` via the GB companion). **No divergence** provided `_stampReactiveCompanion` always runs. Under the OLD reactive-disabled condition at `isReactive=false`, the gate-bulk Meyer term drops out, matching ngspice (where oxideCap=0 produces gcgb=0).

### Diff M-12 — **MODEINITFIX path** (mos1load.c:204)

mos1load.c:204: `(ckt->CKTmode & MODEINITFIX) && (!here->MOS1off)` joins the MODEINITFLOAT voltage-read path. Otherwise (off==1), fall through to 412-434 — which goes to the `else` branch and (since MODEINITJCT isn't set) takes the `vbs=vgs=vds=0` fallback. Our code at mosfet.ts:1611: `if (this._p.OFF && ctx.initMode === "initFix") return true;` for `checkConvergence` — **skips convergence** but the `_updateOp` path doesn't handle MODEINITFIX+OFF separately. **DIVERGENCE**: when off==1 and initMode==initFix, ngspice forces vbs=vgs=vds=0; ours reads from node voltages.

**NEW** — insert in `_updateOpImpl` before the general node-voltage read:
```typescript
    // ngspice mos1load.c:204, 412-434 — MODEINITFIX && off==1 forces
    // vbs=vgs=vds=0 and skips limiting.
    if (ctx.initMode === "initFix" && this._p.OFF) {
      const base = this.stateBaseOffset;
      const s0 = this._s0;
      this._vgs = 0;
      this._vds = 0;
      this._vsb = 0;
      this._swapped = false;
      s0[base + SLOT_MODE] = 1;
      s0[base + SLOT_VBS_OLD] = 0;
      s0[base + SLOT_VBD_OLD] = 0;
      const result = computeIds(0, 0, 0, this._p);
      this._ids = result.ids;  // 0 at vgs=vds=0 when Vto>0
      this._gm = 0;
      this._gds = 0;
      this._gmbs = 0;
      this._lastVdsat = 0;
      s0[base + SLOT_VON] = result.vth;
      // Junction diodes at vbs=vbd=0: gbs=gbd=CKTgmin, cbs=cbd=0
      s0[base + SLOT_GBD] = GMIN;
      s0[base + SLOT_GBS] = GMIN;
      s0[base + SLOT_CBD_I] = -this._drainSatCur;
      s0[base + SLOT_CBS_I] = -this._sourceSatCur;
      s0[base + SLOT_VBD] = 0;
      return;
    }
```
ngspice citation: `mos1load.c:204, 412-434`.

---

## Deliverable 5 — `CKTfixLimit` plumbing

### Diff CKT-1 — `src/solver/analog/load-context.ts`

**OLD** (lines 81-85):
```typescript
  /** Relative convergence tolerance (CKTreltol). */
  reltol: number;
  /** Absolute current tolerance (CKTabstol). */
  iabstol: number;
}
```
**NEW**:
```typescript
  /** Relative convergence tolerance (CKTreltol). */
  reltol: number;
  /** Absolute current tolerance (CKTabstol). */
  iabstol: number;
  /**
   * ngspice CKTfixLimit flag (cktntask.c; default false). When true, the
   * reverse-mode MOSFET limvds pass at mos1load.c:385 is skipped. Devices
   * other than MOS1 may read this as well where they mirror the same gate
   * (MOS2/3/6/9 load files all check ckt->CKTfixLimit).
   */
  cktFixLimit: boolean;
}
```

### Diff CKT-2 — `src/solver/analog/ckt-context.ts`

**OLD** (line 241-253, mode flags block):
```typescript
  /** Current NR init mode. */
  initMode: InitMode = "transient";
  /** True during DC operating point solves. */
  isDcOp: boolean = false;
  ...
  /** Source stepping scale factor (ngspice srcFact). */
  srcFact: number = 1;
  /** True when nodesets are present (derived from nodesets.size > 0). */
  hadNodeset: boolean = false;
```
**NEW** — add field and default near other flags:
```typescript
  /** Current NR init mode. */
  initMode: InitMode = "transient";
  /** True during DC operating point solves. */
  isDcOp: boolean = false;
  ...
  /** Source stepping scale factor (ngspice srcFact). */
  srcFact: number = 1;
  /** True when nodesets are present (derived from nodesets.size > 0). */
  hadNodeset: boolean = false;
  /**
   * ngspice CKTfixLimit option flag (cktntask.c). Default false, matching
   * ngspice's out-of-box behavior. When set, disables the reverse-path
   * DEVlimvds call in MOSFET load (mos1load.c:385) and equivalent MOS2/3/6/9.
   */
  cktFixLimit: boolean = false;
```
And in the `loadCtx` constructor initializer (~line 530-552):
```typescript
    this.loadCtx = {
      solver: this._solver,
      ...
      reltol: params.reltol,
      iabstol: params.abstol,
      cktFixLimit: false,  // ngspice default per cktntask.c
    };
```

### Diff CKT-3 — `src/solver/analog/ckt-load.ts`

**OLD** (cktLoad, lines 45-56):
```typescript
  ctx.loadCtx.iteration = iteration;
  ctx.loadCtx.voltages = ctx.rhsOld;
  ctx.loadCtx.initMode = ctx.initMode;
  ctx.loadCtx.srcFact = ctx.srcFact;
  ctx.loadCtx.gmin = ctx.diagonalGmin;
  ctx.loadCtx.isDcOp = ctx.isDcOp;
  ctx.loadCtx.isTransient = ctx.isTransient;
  ctx.loadCtx.isTransientDcop = ctx.isTransientDcop;
  ctx.loadCtx.isAc = ctx.isAc;
  ctx.loadCtx.noncon.value = 0;
```
**NEW**:
```typescript
  ctx.loadCtx.iteration = iteration;
  ctx.loadCtx.voltages = ctx.rhsOld;
  ctx.loadCtx.initMode = ctx.initMode;
  ctx.loadCtx.srcFact = ctx.srcFact;
  ctx.loadCtx.gmin = ctx.diagonalGmin;
  ctx.loadCtx.isDcOp = ctx.isDcOp;
  ctx.loadCtx.isTransient = ctx.isTransient;
  ctx.loadCtx.isTransientDcop = ctx.isTransientDcop;
  ctx.loadCtx.isAc = ctx.isAc;
  ctx.loadCtx.cktFixLimit = ctx.cktFixLimit;
  ctx.loadCtx.noncon.value = 0;
```

### Diff CKT-4 — `src/solver/analog/element.ts`

Re-exports `LoadContext` from load-context.ts (line 23). **No change needed** — re-export automatically picks up the new field.

---

## Deliverable 6 — Additional divergences surfaced (F-MOS)

1. **Predictor wiring is a no-op** (diff M-1): the current `initPred` branch copies `s1[SLOT_VGS]` etc. to `s0` and then falls through to a node-voltage read that overwrites the state it just set. No xfact, no state2 reference. This silently disables MOSFET predictor entirely.

2. **MODEINITTRAN is NOT wired into the predictor path**: ngspice mos1load.c:206 gates predictor on `MODEINITPRED | MODEINITTRAN`. Our branch only checks `initMode === "initPred"` (mosfet.ts:1227). So the first transient step does not extrapolate — it reads raw node voltages, which may be stale DCOP values, causing bad first-step Jacobians.

3. **`MOS1von` stored polarity** (mosfet.ts:1360): we write `s0[base + SLOT_VON] = result.vth` where `vth` is positive-convention. ngspice mos1load.c:557 writes `MOS1von = type*von`. If any external reader (harness, convergence log, MCP netlist snapshot) reads SLOT_VON expecting node-polarity, they get magnitude. Document in a comment at mosfet.ts:1360 or apply the `type*` multiply.

4. **Per-instance `vt` in junction eval** (Diff M-9): we hardcode global `VT = REFTEMP*KoverQ`. When `ctx.cktTemp !== REFTEMP` (future feature), bulk diode cbd/gbd are evaluated at the wrong temperature. Matched for our fixed-T simulation but not portable.

5. **MODEINITFIX+OFF handling** (Diff M-12): `off==1, initMode=initFix` — ngspice forces vbs=vgs=vds=0; ours reads node voltages. Matters when OFF-flag devices are mixed with other operating devices.

6. **Bypass test absent** (Diff M-4): ngspice can skip 90%+ of the device computations when the device is in steady state. Missing this is a performance-only divergence, but it also **changes the exact NR trajectory slightly** because ngspice's decision to bypass also decides when to re-write state0. Parity with ngspice's step-by-step CKTrhs trajectory will require this.

7. **MODEINITSMSIG absent** (Diff M-2): AC small-signal analysis currently does not distinguish MODEINITSMSIG from MODEFLOAT. ngspice-level AC parity will require this.

8. **Check aggregation gate** (Diff M-6): `(off==0) || !(MODEINITFIX|MODEINITSMSIG)` — ours always increments when pnjlim fires. Can cause spurious noncon during MODEINITSMSIG AC sensitivity.

9. **CKTfixLimit absent** (Diff M-5, Deliverable 5): reverse-mode `-limvds(-vds, -state0_vds)` is always applied. ngspice users can set `.option fixlimit` to disable it. Minor but option-parity is broken.

10. **Sensitivity (CKTsenInfo) branch**: mos1load.c:109-199 has a 90-line CKTsenInfo branch handling sensitivity analysis. **Entirely absent** in our MOSFET. This is a whole-engine scope item, not MOSFET-only.

11. **Noise model** (mos1noi.c): Absent. Our code has KF/AF parameters in the defaults (`MOSFET_NMOS_PARAM_DEFS.secondary.KF/AF`), so parameters parse, but no noise analysis exists.

12. **`LD` sign in effectiveLength**: mos1load.c:129 uses `MOS1latDiff` (positive or negative). ngspice subtracts `2*MOS1latDiff` regardless of sign. Ours (`p.LD ?? 0`, mosfet.ts:557) treats as positive only via `p.LD ?? 0` — parse pathway allows negative. Will subtract correctly — OK.

13. **`Cox` / `oxideCap`** (mosfet.ts:1742): we compute `EPS_OX * EPS0 / TOX` where `EPS_OX = 3.9`. ngspice mos1temp.c:64 uses `3.9 * 8.854214871e-12 / MOS1oxideThickness` — identical. OK.

14. **`f2d/f3d/f4d` formulas** (mosfet.ts:1110-1117): match mos1temp.c:238-253. OK.

15. **Meyer gate cap `vgs/vgd` choice** (mosfet.ts:1193-1201): mode-dependent swap to pass `(vgd, vgs, vgb)` for reverse mode — matches mos1load.c:779-784. `vdsat` passed is stored `_lastVdsat` from the IV block — OK.

16. **Meyer `capgs + capgd + capgb` first-step averaging** (mosfet.ts:1210): uses `tranStep === 0 ? 2*meyerGs : meyerGs + prevMeyerGs`. ngspice mos1load.c:789-805: `2*state0[capgs]+overlap` only under `MODETRANOP|MODEINITSMSIG`; `state0+state1+overlap` under `MODETRAN`. Our `tranStep===0` path fires for MODETRANOP and MODEINITTRAN. mos1load.c MODEINITTRAN path (796-805) uses `state0+state1+overlap`, NOT `2*state0+overlap`. **DIVERGENCE on the transient boot step** — at the first transient step (post-DCOP), ngspice does `state0 + state1 + overlap` where state1 is the last-DCOP half-cap. Ours uses `2*state0`, ignoring DCOP state1. This is a real divergence on step 1 of transient.

17. **Junction-cap linearization guard** (mosfet.ts:1682): `if (vbd < this._tDepCap)`. mos1load.c:650 `if (vbd < here->MOS1tDepCap)`. Matches.

18. **`junctionCap` helper** (mosfet.ts:797-808): matches SPICE3 standard form but NOT used in the stamp path — the stamp path at mosfet.ts:1682-1695 computes its own capbd/qbd. Dead helper. Not a bug, but note `junctionCap` is exported (mosfet.ts:797) and never called from production code. Candidate for deletion or for test use only.

19. **`W/L` multiplier `M`** (mosfet.ts:558): Beta = tKP * W/L * M. ngspice mos1load.c:148-149: `Beta = MOS1tTransconductance * MOS1m * MOS1w / EffectiveLength`. Matches.

20. **Overlap cap `M` multiplier** (mosfet.ts:497-501): applied once in `resolveParams`; mos1load.c:142-147 multiplies M into `GateSourceOverlapCap = MOS1gateSourceOverlapCapFactor * MOS1m * MOS1w`. Our approach pre-multiplies M into CGDO/CGSO/CGBO — equivalent but breaks `setParam("M", ...)` hot-reload. If the user sets M after construction, the overlap caps are re-multiplied on every call. **LATENT BUG**: `setParam("M", 2)` applied twice would cube M not square-it. Trace at mosfet.ts:1603-1608 → `setParam` → `_recomputeTempParams()` → does NOT re-run `resolveParams`, so overlap caps keep the original M. In practice M is constant — but document or move the M multiplier into the per-iteration computation.

21. **`Cbs/Cbd` area-based resolution** (`resolveParams` vs mos1temp.c:218-289): our code at mosfet.ts:1095-1101 chooses `this._tCbd` when `CBD > 0`, else `this._tCj * AD`. ngspice mos1temp.c:218-226 uses `capBDGiven` (from parser): if CBD was given → `MOS1tCbd * MOS1m`; else if bulkCapFactorGiven (CJ) → `MOS1tCj * MOS1m * MOS1drainArea`; else 0. Our `p.CBD > 0` gate differs from ngspice's "given" gate when CBD=0 is an explicit user setting. Document as permitted divergence (no way to tell "unset" from "zero" in our param bag).

22. **Bulk diode `cbs/cbd` vbs/vbd reads** (mosfet.ts:1417-1436): reads from **limited** `vbs = s0[base + SLOT_VBS_OLD]` and `vbd = -vsb - vds`. mos1load.c:453-468 uses the **pnjlim-applied** vbs/vbd. Matches.

23. **`primeJunctions` vs ngspice MODEINITJCT icVDS/VGS/VBS**: Our `primeJunctions` (mosfet.ts:1615) hardcodes the all-zero-ICs fallback. ngspice `.IC` on MOSFETs gets `IC_VDS`, `IC_VGS`, `IC_VBS`. MosfetParams/ResolvedMosfetParams have no such fields. Add per Diff M-3.

24. **`tTransconductance` temperature scaling**: mos1temp.c:166 `MOS1tTransconductance = MOS1transconductance / ratio4`. Ours at mosfet.ts:1017 `this._tTransconductance = p.KP / ratio4`. Matches for `ratio = here->MOS1temp/model->MOS1tnom`. OK.

25. **`tVbi` formula** (mosfet.ts:1025-1027): mos1temp.c:170-174 `MOS1tVbi = MOS1vt0 - type*(gamma*sqrt(phi)) + 0.5*(egfet1-egfet) + type*0.5*(tPhi - phi)`. Ours: `_tVbi = p.VTO - type*(p.GAMMA*Math.sqrt(p.PHI)) + 0.5*(egfet1-egfet) + type*0.5*(_tPhi - p.PHI)`. Matches when type is signed (+1 NMOS, -1 PMOS). **But our PMOS uses `p.VTO = Math.abs(p.VTO)`** (mosfet.ts:973). This inverts one term. Expand for PMOS: ours `_tVbi = |VTO| - (-1)*gamma*sqrt(PHI) + ... = |VTO| + gamma*sqrt(PHI) + ...`. ngspice (where VTO is signed negative for PMOS, type=-1): `tVbi = VTO_signed - (-1)*gamma*sqrt(PHI) + ... = VTO_signed + gamma*sqrt(PHI) + ...`. `|VTO| ≠ VTO_signed` for PMOS ⇒ **tVbi differs by `2*VTO_signed = -2*|VTO|`** for PMOS. This propagates through `_tVto = _tVbi + type*gamma*sqrt(_tPhi)`. **POTENTIAL CRITICAL BUG FOR PMOS.** However, the IV block in `computeIds` also uses `_tVto` + polarity-flipped vgs, which may cancel. Recommend running a PMOS-with-gamma-nonzero comparison test against ngspice to verify.

26. **`computeGmbs` sign convention** (mosfet.ts:678-707): `dVthdVsb = gamma/(2*sarg)`. ngspice mos1load.c:513 `arg = gamma/(sarg+sarg)`. Matches. `gmbs = gm * arg`. Matches.

27. **`MOS1cd` stamp direction**: ngspice mos1load.c:563 `MOS1cd = MOS1mode * cdrain - MOS1cbd`. Our convergence check at fet-base.ts:450 uses `cdFinal = mode * ids - cbdI`. Matches.

28. **Noise parameters `KF, AF`**: params present in defaults, no simulation code consumes them.

29. **`sensitivity analysis`**: zero coverage. The entire mos1load.c:109-199 sensInfo branch is missing. Scope: engine-level, not MOSFET-specific.

30. **Missing parameters vs ngspice mos1pTable/mos1mPTable**: ngspice MOS1 instance params include `IC_VDS`, `IC_VGS`, `IC_VBS`, `TEMP`, `DTEMP`, `OFF`. Our `MosfetParams` has `OFF`, `TNOM`. Missing `IC_VDS/VGS/VBS`, `TEMP` (per-instance override), `DTEMP`. Model params include `KF, AF, NLEV, FC`. We have KF, AF, FC (no NLEV). Documented as absent.

31. **Mode flip detection vs ngspice `MOS1mode`**: mos1load.c:472-478 sets `MOS1mode` based on `vds >= 0` AFTER limiting. Ours sets `_swapped = vds < 0` and `SLOT_MODE = swapped ? -1 : 1` also after limiting. Matches.

32. **stampCompanion first-TRAN averaging for junction caps** (mosfet.ts:1682-1705): We always use `order`-based trapezoidal integration for the DB/SB caps. ngspice mos1load.c:714-724 uses NIintegrate which internally picks trap/gear based on method. As long as our `niIntegrate` matches ngspice NIintegrate, OK. **But** the "MODEINITTRAN first-step companion=0" treatment at mosfet.ts:1780-1785 zeroes `CAP_GEQ_GB/CCAP_DB/CCAP_SB` on first transient step. mos1load.c:862-873 zeroes **gcgs/ceqgs/gcgd/ceqgd/gcgb/ceqgb** on first transient step — only the **gate** caps, not the bulk junction companions. ngspice lets NIintegrate on qbs/qbd run normally even on MODEINITTRAN. **DIVERGENCE**: our MODEINITTRAN path zeroes SLOT_CCAP_DB and SLOT_CCAP_SB unconditionally; ngspice does not zero the junction cap companions on MODEINITTRAN.

33. **Reactive-gate condition check** (mosfet.ts:982): `hasCaps = caps.cbd>0 || caps.cbs>0 || caps.cgs>0 || caps.cgd>0 || caps.cgb>0 || oxideCap>0`. If TOX=0, oxideCap=0; combined with CBD=CBS=CGSO=CGDO=CGBO=0, isReactive=false ⇒ no stampCompanion runs. Matches ngspice's "if no capacitance, emit nothing" behavior. OK.

---

## References

- `C:/local_working_projects/digital_in_browser/ref/ngspice/src/spicelib/devices/mos1/mos1load.c:205-240` — PREDICTOR xfact extrapolation of vbs/vgs/vds, vbd derivation.
- `C:/local_working_projects/digital_in_browser/ref/ngspice/src/spicelib/devices/mos1/mos1load.c:282-347` — bypass test (missing in ours).
- `C:/local_working_projects/digital_in_browser/ref/ngspice/src/spicelib/devices/mos1/mos1load.c:360-407` — fetlim/limvds/pnjlim with CKTfixLimit gate at 385.
- `C:/local_working_projects/digital_in_browser/ref/ngspice/src/spicelib/devices/mos1/mos1load.c:419-433` — MODEINITJCT icVDS/VGS/VBS handling.
- `C:/local_working_projects/digital_in_browser/ref/ngspice/src/spicelib/devices/mos1/mos1load.c:500-546` — Shichman-Hodges cutoff/saturation/linear.
- `C:/local_working_projects/digital_in_browser/ref/ngspice/src/spicelib/devices/mos1/mos1load.c:737-743` — Check/CKTnoncon gate.
- `C:/local_working_projects/digital_in_browser/ref/ngspice/src/spicelib/devices/mos1/mos1load.c:789-805` — Meyer cap TRANOP/TRAN/INITSMSIG averaging.
- `C:/local_working_projects/digital_in_browser/ref/ngspice/src/spicelib/devices/mos1/mos1load.c:827-837` — predictor extrapolation of qgs/qgd/qgb.
- `C:/local_working_projects/digital_in_browser/ref/ngspice/src/spicelib/devices/mos1/mos1temp.c:135-201` — instance temp scaling.
- `C:/local_working_projects/digital_in_browser/ref/ngspice/src/spicelib/devices/mos1/mos1conv.c:36-95` — convergence test cdhat/cbhat.
- `C:/local_working_projects/digital_in_browser/src/solver/analog/fet-base.ts:253-266,399-470,642-671` — base load/checkConvergence/LTE.
- `C:/local_working_projects/digital_in_browser/src/components/semiconductors/mosfet.ts:898,1219-1292,1633-1786` — MOSFET _updateOp and _stampCompanion overrides.
- `C:/local_working_projects/digital_in_browser/src/components/semiconductors/mosfet.ts:1226-1236` — broken initPred stub (Diff M-1 target).
- `C:/local_working_projects/digital_in_browser/src/components/semiconductors/mosfet.ts:722-750` — limitVoltages lacking CKTfixLimit (Diff M-5 target).
- `C:/local_working_projects/digital_in_browser/src/solver/analog/load-context.ts:31-85` — LoadContext interface (add cktFixLimit).
- `C:/local_working_projects/digital_in_browser/src/solver/analog/ckt-context.ts:241-553` — CKTCircuitContext (add cktFixLimit field + seed loadCtx).
- `C:/local_working_projects/digital_in_browser/src/solver/analog/ckt-load.ts:45-56` — cktLoad (sync cktFixLimit into loadCtx).
- `C:/local_working_projects/digital_in_browser/src/solver/analog/element.ts:23` — re-export auto-propagates.
- `C:/local_working_projects/digital_in_browser/src/solver/analog/newton-raphson.ts:89,133,190` — fetlim/limvds/pnjlim helpers (correct; no change).
- `C:/local_working_projects/digital_in_browser/src/components/semiconductors/njfet.ts:130` — JFET extends same base (coordinate with F5-ext).

agentId: a60fdc8b37ac143d0 (use SendMessage with to: 'a60fdc8b37ac143d0' to continue this agent)
<usage>total_tokens: 195592
tool_uses: 29
duration_ms: 555065</usage>