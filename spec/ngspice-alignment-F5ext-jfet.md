# ngspice alignment — F5-ext: JFET full convergence port

_Extracted from ephemeral tool-results cache. Source agent output verbatim below._

---

I have enough context now. I have everything needed to produce the full diff set. Compiling the deliverable.

---

# JFET / ngspice Alignment Diff Set (F5-D, F5-E, plus surfaced divergences)

## Summary

ngspice `jfetload.c` differs from our current `njfet.ts` / `pjfet.ts` in ways well beyond just the missing VGD limiting and the banned Vds clamp. This report enumerates every divergence found during the end-to-end read. Concrete OLD/NEW blocks for the VGS-limiter branch, state-slot extension, VGD apparatus, MODEINITPRED block, MODEINITJCT handling, Vds-clamp removal, icheck aggregation, convergence test, and MODEINITSMSIG are given inline. Additional divergences — fetlim on VGS **and** VGD (Sydney-model "second limiter"), Shichman-Hodges I-V equation deltas, bypass path, OFF-handling, stamping-order reorientation for PJFET, and charge-storage integration — are raised loudly in the "Additional divergences surfaced" section.

---

## Deliverable 1 — Full read of `ref/ngspice/src/spicelib/devices/jfet/jfetload.c`

### Section-by-section summary

| Lines | Section | Purpose |
|---|---|---|
| 1–21 | Header / externals | License; `ni_get_dev_index`, `ni_limit_record` externs (limit telemetry) |
| 22–30 | `JFETload()` signature | Standard ngspice DEVload signature, GENmodel* + CKTcircuit* |
| 30–83 | Locals | `beta`, `gdpr`, `gspr`, `csat`, vgs, vgd, vds, delvgs, delvgd, delvds, evgs, evgd, icheck, ichk1, `#ifndef PREDICTOR` xfact, plus Sydney-University mod locals `vto`, `apart`, `cpart`, `Bfac` |
| 85–90 | Model/instance loops | Standard outer/inner loop |
| 92–98 | DC param pre-compute | `beta = tBeta*area; gdpr = drainConduct*area; gspr = sourceConduct*area; csat = tSatCur*area` |
| 99–123 | **MODEINITSMSIG / MODEINITTRAN / MODEINITJCT / MODEINITFIX initialization** | See mechanism list below |
| 124–164 | **MODEINITPRED** (default build, since PREDICTOR is NOT defined) | See mechanism list below |
| 165–174 | delvgs/delvgd/delvds/cghat/cdhat computation | Predicted currents for bypass & convergence |
| 175–208 | Bypass block | Solution-unchanged short-circuit, `goto load` |
| 209–242 | **Voltage limiting** | DEVpnjlim on vgs AND vgd, DEVfetlim on vgs AND vgd |
| 244–270 | Gate junction I-V (Shockley with `-3*vt_temp` cutoff branch) | Separate computation for vgs and vgd diodes |
| 271–348 | **Sydney-University Shichman-Hodges drain current** (modified `cdrain`, gm, gds) | Normal/inverse mode; cutoff/linear/saturation inside each |
| 350–419 | `#ifdef notdef` original Shichman-Hodges (not compiled) | Present for reference |
| 421–424 | `cd = cdrain - cgd` | Drain current less gate-drain diode current |
| 425–494 | **Charge storage + NIintegrate** | MODETRAN/MODEAC/MODEINITSMSIG; qgs/qgd computation; MODEINITSMSIG skip + continue; MODEINITTRAN state1 copy; NIintegrate; MODEINITTRAN copy-back for cqgs/cqgd |
| 495–508 | **Convergence check** | `icheck==1` OR `|cghat-cg|>...` OR `|cdhat-cd|>...` → `CKTnoncon++`, `CKTtroubleElt = here` |
| 509–517 | **State-slot write-back** for vgs, vgd, cg, cd, cgd, gm, gds, ggs, ggd | Always executed post-convergence-test, outside bypass |
| 518–550 | `load:` label — RHS + MNA stamps | Same current vector + 16 matrix stamps |

### Every convergence-related mechanism

#### (1) **MODEINITSMSIG** (jfetload.c:103–105)
```c
if( ckt->CKTmode & MODEINITSMSIG) {
    vgs= *(ckt->CKTstate0 + here->JFETvgs);
    vgd= *(ckt->CKTstate0 + here->JFETvgd);
}
```
Reads previously-converged vgs, vgd from state0 (set by the last NR's write-back at line 509–510). Then falls through to I-V evaluation; the skip+continue at line 466–467 prevents the NIintegrate call and stamps only small-signal caps to state0.

#### (2) **MODEINITTRAN** (jfetload.c:106–108)
```c
else if (ckt->CKTmode & MODEINITTRAN) {
    vgs= *(ckt->CKTstate1 + here->JFETvgs);
    vgd= *(ckt->CKTstate1 + here->JFETvgd);
}
```
On first iteration of transient first-step, seed from state1 (last accepted DC-OP).

#### (3) **MODEINITJCT + MODETRANOP + MODEUIC** (jfetload.c:109–114)
```c
vds=model->JFETtype*here->JFETicVDS;
vgs=model->JFETtype*here->JFETicVGS;
vgd=vgs-vds;
```
Use-initial-conditions path: seed from ICVDS/ICVGS with type polarity.

#### (4) **MODEINITJCT / OFF==0** (jfetload.c:115–118)
```c
vgs = -1;
vgd = -1;
```

#### (5) **MODEINITJCT || (MODEINITFIX && OFF)** (jfetload.c:119–122)
```c
vgs = 0;
vgd = 0;
```

#### (6) **MODEINITPRED** branch (jfetload.c:124–149) — **DEFAULT BUILD since `#ifndef PREDICTOR` is active**
```c
if(ckt->CKTmode & MODEINITPRED) {
    xfact=ckt->CKTdelta/ckt->CKTdeltaOld[1];
    *(ckt->CKTstate0 + here->JFETvgs) = *(ckt->CKTstate1 + here->JFETvgs);
    vgs = (1+xfact)* *(ckt->CKTstate1 + here->JFETvgs) - xfact* *(ckt->CKTstate2 + here->JFETvgs);
    *(ckt->CKTstate0 + here->JFETvgd) = *(ckt->CKTstate1 + here->JFETvgd);
    vgd = (1+xfact)* *(ckt->CKTstate1 + here->JFETvgd) - xfact* *(ckt->CKTstate2 + here->JFETvgd);
    *(ckt->CKTstate0 + here->JFETcg)  = *(ckt->CKTstate1 + here->JFETcg);
    *(ckt->CKTstate0 + here->JFETcd)  = *(ckt->CKTstate1 + here->JFETcd);
    *(ckt->CKTstate0 + here->JFETcgd) = *(ckt->CKTstate1 + here->JFETcgd);
    *(ckt->CKTstate0 + here->JFETgm)  = *(ckt->CKTstate1 + here->JFETgm);
    *(ckt->CKTstate0 + here->JFETgds) = *(ckt->CKTstate1 + here->JFETgds);
    *(ckt->CKTstate0 + here->JFETggs) = *(ckt->CKTstate1 + here->JFETggs);
    *(ckt->CKTstate0 + here->JFETggd) = *(ckt->CKTstate1 + here->JFETggd);
}
```
Note: `xfact = CKTdelta / CKTdeltaOld[1]` (NOT `deltaOld[0]/deltaOld[1]` as used elsewhere — per jfetload.c's literal). Copies 9 slots from state1→state0, then extrapolates vgs/vgd.

#### (7) **Floating (ELSE)** (jfetload.c:150–164)
```c
vgs = model->JFETtype*(*(ckt->CKTrhsOld+gateNode) - *(ckt->CKTrhsOld+sourcePrimeNode));
vgd = model->JFETtype*(*(ckt->CKTrhsOld+gateNode) - *(ckt->CKTrhsOld+drainPrimeNode));
```

#### (8) **delvgs/delvgd/delvds + cghat/cdhat** (jfetload.c:165–174)
```c
delvgs = vgs - state0[JFETvgs]; delvgd = vgd - state0[JFETvgd]; delvds = delvgs - delvgd;
cghat = state0[JFETcg] + state0[JFETggd]*delvgd + state0[JFETggs]*delvgs;
cdhat = state0[JFETcd] + state0[JFETgm]*delvgs + state0[JFETgds]*delvds - state0[JFETggd]*delvgd;
```

#### (9) **Bypass** (jfetload.c:175–208)
4-nested-`if` chain with `CKTbypass && !MODEINITPRED && fabs(delvgs)<... && fabs(delvgd)<... && fabs(cghat-cg)<... && fabs(cdhat-cd)<...`. On pass: re-read all state0 slots then `goto load`.

#### (10) **DEVpnjlim on vgs** (jfetload.c:217–219)
```c
vgs = DEVpnjlim(vgs, state0[JFETvgs], JFETtemp*CONSTKoverQ, JFETvcrit, &icheck);
ni_limit_record(di, 3, vgs_before, vgs);
```

#### (11) **DEVpnjlim on vgd** (jfetload.c:222–226) — **MISSING from our model**
```c
vgd = DEVpnjlim(vgd, state0[JFETvgd], JFETtemp*CONSTKoverQ, JFETvcrit, &ichk1);
ni_limit_record(di, 5, vgd_before, vgd);
```

#### (12) **icheck aggregation** (jfetload.c:227–229)
```c
if (ichk1 == 1) { icheck = 1; }
```
If either vgs OR vgd got limited, icheck is set — used to force noncon at line 500.

#### (13) **DEVfetlim on vgs** (jfetload.c:231–234) — **MISSING from our model**
```c
vgs = DEVfetlim(vgs, state0[JFETvgs], here->JFETtThreshold);
```

#### (14) **DEVfetlim on vgd** (jfetload.c:237–240) — **MISSING from our model**
```c
vgd = DEVfetlim(vgd, state0[JFETvgd], here->JFETtThreshold);
```

#### (15) **Final convergence test** (jfetload.c:498–508)
```c
if( (!(ckt->CKTmode & MODEINITFIX)) | (!(ckt->CKTmode & MODEUIC))) {
    if((icheck == 1) ||
       (fabs(cghat-cg) >= CKTreltol*MAX(|cghat|,|cg|)+CKTabstol) ||
       (fabs(cdhat-cd) >  CKTreltol*MAX(|cdhat|,|cd|)+CKTabstol)) {
        ckt->CKTnoncon++;
        ckt->CKTtroubleElt = (GENinstance*) here;
    }
}
```
Note: `>=` for cghat, `>` for cdhat — this is literal ngspice asymmetry.

#### (16) **State slot write-back** (jfetload.c:509–517) — **9 slots, always, outside bypass**
```c
state0[JFETvgs] = vgs; state0[JFETvgd] = vgd;
state0[JFETcg] = cg; state0[JFETcd] = cd; state0[JFETcgd] = cgd;
state0[JFETgm] = gm; state0[JFETgds] = gds;
state0[JFETggs] = ggs; state0[JFETggd] = ggd;
```

### State slot layout (jfetdefs.h)

Slots per instance: `JFETvgs`, `JFETvgd`, `JFETcg`, `JFETcd`, `JFETcgd`, `JFETgm`, `JFETgds`, `JFETggs`, `JFETggd`, `JFETqgs`, `JFETcqgs`, `JFETqgd`, `JFETcqgd`. Total **13 per-instance state slots**.

---

## Deliverable 2 — Current state of `njfet.ts` / `pjfet.ts`

### Current state slot layout (`njfet.ts:62–71`)
```
SLOT_VGS_JUNCTION = 45
SLOT_GD_JUNCTION  = 46   (actually holds ggs: gate-SOURCE conductance, mis-named!)
SLOT_ID_JUNCTION  = 47   (holds cg: gate-source junction current)
```
Base FET slots (40) are inherited from `FET_BASE_SCHEMA` (fet-base.ts:49–100). There are **no slots** for: `vgd`, `cg` aggregate, `cd`, `cgd`, `gm_jfet`, `gds_jfet`, `ggd`, `qgs`, `qgd`, `cqgs`, `cqgd`. ngspice tracks 13 per-instance slots; we track 3 device-specific plus inherited 40 FET-base. **10 of the 13 are missing** (some aliased via MOSFET-shared SLOT_GM/SLOT_GDS/SLOT_IDS, but vgd/ggd/cgd/cd/qgd/cqgd are simply absent).

### Current convergence apparatus

| ngspice mechanism | njfet.ts / pjfet.ts |
|---|---|
| (1) MODEINITSMSIG read vgs,vgd from state0 | **NOT IMPLEMENTED** — no `initSmsig` branch |
| (2) MODEINITTRAN read from state1 | **NOT IMPLEMENTED** |
| (3) MODEINITJCT + MODETRANOP + MODEUIC (ICVDS/ICVGS) | **NOT IMPLEMENTED** — `primeJunctions()` always seeds `vgs=-1, vds=0` |
| (4) MODEINITJCT with OFF==0 → `vgs=-1, vgd=-1` | Partial — sets `_vgs=-1, _vds=0` (which implies `vgd=-1`), but no `_vgd_junction` slot exists |
| (5) MODEINITJCT with OFF → `vgs=0, vgd=0` | **NOT IMPLEMENTED** — no OFF parameter |
| (6) MODEINITPRED state1→state0 copies + xfact vgs/vgd extrapolation | **NOT IMPLEMENTED** — no `initPred` branch in `_updateOp` |
| (7) Floating vgs/vgd read from rhsOld | Uses `ctx.voltages` (CKTrhsOld proxy); reads vgs only; **vgd computed implicitly as `vgs - vds` rather than separately from MNA** |
| (8) delvgs/delvgd/cghat/cdhat | **NOT IMPLEMENTED** |
| (9) Bypass | **NOT IMPLEMENTED** |
| (10) DEVpnjlim on vgs | Implemented twice — once on channel vGraw (`_vgs`), once on `_vgs_junction` (njfet.ts:298–327). The channel call at line 300 is **wrong** — jfetload.c applies pnjlim to channel junctions not channel voltages; it applies pnjlim to gate-source AND gate-drain junction voltages. Our "channel" call is duplicative and uses the wrong old-value. |
| (11) DEVpnjlim on vgd | **NOT IMPLEMENTED** (this is F5-E) |
| (12) `ichk1` aggregation | **NOT IMPLEMENTED** |
| (13) DEVfetlim on vgs | **NOT IMPLEMENTED** |
| (14) DEVfetlim on vgd | **NOT IMPLEMENTED** |
| (15) Final `icheck || |cghat-cg|>... || |cdhat-cd|>...` convergence test | **NOT IMPLEMENTED** — element falls through to FET-base `checkConvergence` (fet-base.ts:399), which is a **MOS1convTest port that reads MOSFET-specific slots (SLOT_VSB, SLOT_VBD, SLOT_GBD, SLOT_CBD_I) that have no meaning for JFET** |
| (16) State slot write-back for all 9 convergence slots | Partial — `_vgs`, `_vds`, `_ids`, `_gm`, `_gds` and junction slots are written; `vgd`, `cg`, `cd`, `cgd`, `ggd` are NOT written to state0 (no slots exist) |
| Sydney-University Shichman-Hodges drain current | **NOT IMPLEMENTED** — we use the `#ifdef notdef` original (jfetload.c:350–419), not the Sydney modification at jfetload.c:271–348 |
| Gate-drain diode current `cgd` + `ggd` | **NOT IMPLEMENTED** — we model only ONE gate junction (gate-source); ngspice models gate-source AND gate-drain as separate Shockley diodes |
| `-3*vt_temp` cutoff branch | **NOT IMPLEMENTED** — we use `Math.min(..., 80)` exp-argument clamp (the pragmatic substitute), not ngspice's analytic cubic tail at `vgs < -3*vt_temp` |
| Vds hard-clamp `[-10, 50]` (F5-D) | Present at `njfet.ts:180-184`, `pjfet.ts:101-103` — **banned pragmatic patch** |

### Every divergence from jfetload.c

**CONV-1 (F5-D)**: Vds hard-clamp at `njfet.ts:180-184` and `pjfet.ts:101-103`. ngspice has no such clamp. This is a substitute for missing fetlim and missing vgd-junction limiting.

**CONV-2 (F5-E)**: No `DEVpnjlim` call on vgd. ngspice calls pnjlim on BOTH vgs and vgd at jfetload.c:217 and 223.

**CONV-3**: No `DEVfetlim` call on vgs or vgd. ngspice applies fetlim (threshold-voltage-aware channel limiter) at jfetload.c:232, 238 — this is the second limiter in the Sydney-U extension.

**CONV-4**: No `_vgd_junction` state slot. ngspice requires `JFETvgd`, `JFETggd`, `JFETcgd`, `JFETqgd`, `JFETcqgd` for the gate-DRAIN junction diode.

**CONV-5**: No MODEINITPRED handling. ngspice extrapolates vgs/vgd across steps and copies 9 slots from state1→state0.

**CONV-6**: No MODEINITSMSIG handling. ngspice's cktop.c post-convergence pass relies on this branch to populate small-signal capacitances without re-running NIintegrate.

**CONV-7**: No MODEINITJCT + MODEUIC path reading ICVDS/ICVGS.

**CONV-8**: `checkConvergence` inherited from `AbstractFetElement` (fet-base.ts:399) is a MOS1convTest port — reads SLOT_VBD, SLOT_GBD, SLOT_CBD_I which are zeros for JFET, giving a degenerate `cdhat == cd` check that always passes. JFET needs its own icheck || |cghat-cg|>tol || |cdhat-cd|>tol test.

**CONV-9**: Drain current uses the `#ifdef notdef` original equations (simple saturation/linear) rather than the Sydney-University model at jfetload.c:271–348 with `JFETbFac`, `apart = 2b+3Bfac(vgst-vds)`, `cpart`.

**CONV-10**: Gate diode uses `exp(v/vt)` clamped at 80, not ngspice's `vgs < -3*vt_temp` cubic-tail analytic branch.

**CONV-11**: `pjfet.ts:146-147` polarity convention is `vGraw = -(vG-vS)`. ngspice uses `vgs = JFETtype*(vG - vS)` (jfetload.c:154). For PJFET `JFETtype = -1`, so algebraically identical — but our code stores this as "Vsg" then treats it as "vgs" in I-V equations. This works only because our I-V equations are also polarity-flipped, not because we matched ngspice. The correct port would keep `vgs = JFETtype*(vG-vS)` and use Sydney equations with the pinch-off sign encoded in `vto = JFETtype*vto`.

**CONV-12**: `SLOT_GD_JUNCTION` and `SLOT_ID_JUNCTION` are named as if for a gate-drain junction but hold gate-source-junction data. Misleading; reader will assume CONV-4 is implemented when it isn't.

---

## Deliverable 3 — Concrete diff for `njfet.ts`

### Diff 3.1 — State schema: add VGD, GGD, CGD, CD, CG, CGD_I, QGS, QGD, CQGS, CQGD, GM_JFET, GDS_JFET, GGS slots (and rename misleading ones)

**OLD** `njfet.ts:58-71`
```
  58	// ---------------------------------------------------------------------------
  59	// JFET state-pool slots
  60	// ---------------------------------------------------------------------------
  61	
  62	export const SLOT_VGS_JUNCTION = 45;
  63	export const SLOT_GD_JUNCTION  = 46;
  64	export const SLOT_ID_JUNCTION  = 47;
  65	
  66	const JFET_SCHEMA = defineStateSchema("NJfetAnalogElement", [
  67	  ...FET_BASE_SCHEMA.slots,
  68	  { name: "VGS_JUNCTION", doc: "Gate-source junction voltage (NR linearization state)", init: { kind: "zero" } },
  69	  { name: "GD_JUNCTION",  doc: "Gate-source junction conductance (NR linearization state)", init: { kind: "constant", value: GMIN } },
  70	  { name: "ID_JUNCTION",  doc: "Gate-source junction current (NR linearization state)", init: { kind: "zero" } },
  71	] as const);
```

**NEW**
```ts
// ---------------------------------------------------------------------------
// JFET state-pool slots — mirror ngspice jfetdefs.h (JFETvgs, JFETvgd,
// JFETcg, JFETcd, JFETcgd, JFETgm, JFETgds, JFETggs, JFETggd, JFETqgs,
// JFETcqgs, JFETqgd, JFETcqgd). Some ngspice slots (vgs/gm/gds/ids) are
// aliased to FET_BASE_SCHEMA inherited slots (SLOT_VGS, SLOT_GM, SLOT_GDS,
// SLOT_IDS); the JFET-specific ones are appended here.
// ---------------------------------------------------------------------------

// --- Gate-source junction (Shockley diode) — jfetdefs JFETggs/JFETcg ---
export const SLOT_VGS_JUNCTION = 45;   // JFETvgs (alias: FET_BASE SLOT_VGS holds the channel Vgs; this is the junction-diode Vgs tracked by DEVpnjlim)
export const SLOT_GGS_JUNCTION = 46;   // JFETggs — gate-source junction conductance (was mis-named GD_JUNCTION)
export const SLOT_CG_JUNCTION  = 47;   // JFETcg  — gate (total) current at operating point; was mis-named ID_JUNCTION

// --- Gate-drain junction (Shockley diode) — jfetdefs JFETvgd/JFETggd/JFETcgd ---
export const SLOT_VGD_JUNCTION = 48;   // JFETvgd — gate-drain junction voltage (NR linearization state for DEVpnjlim on vgd)
export const SLOT_GGD_JUNCTION = 49;   // JFETggd — gate-drain junction conductance
export const SLOT_CGD_JUNCTION = 50;   // JFETcgd — gate-drain junction current

// --- Channel predicted-current history — jfetdefs JFETcd ---
export const SLOT_CD_CHANNEL   = 51;   // JFETcd — drain current used in cdhat convergence predictor (cd = cdrain - cgd)

// --- Gate junction charges (MODEINITTRAN history + MODEINITSMSIG capacitance) — JFETqgs/JFETqgd ---
export const SLOT_QGS_JFET     = 52;   // JFETqgs — gate-source junction charge (integrated across transient)
export const SLOT_QGD_JFET     = 53;   // JFETqgd — gate-drain junction charge
export const SLOT_CQGS_JFET    = 54;   // JFETcqgs — gate-source companion current from NIintegrate
export const SLOT_CQGD_JFET    = 55;   // JFETcqgd — gate-drain companion current from NIintegrate

// --- MODEINITPRED aliases — read VGS/GM/GDS/IDS from FET_BASE slots ---
// JFETvgs   ≡ FET_BASE_SCHEMA SLOT_VGS  (0)
// JFETgm    ≡ FET_BASE_SCHEMA SLOT_GM   (2)
// JFETgds   ≡ FET_BASE_SCHEMA SLOT_GDS  (3)
// (No aliasing for CD — JFET cdrain is before gate-drain diode subtraction;
//  FET_BASE SLOT_IDS holds cdrain, JFET SLOT_CD_CHANNEL holds cd=cdrain-cgd)

const JFET_SCHEMA = defineStateSchema("NJfetAnalogElement", [
  ...FET_BASE_SCHEMA.slots,
  // Gate-source junction (13 JFET-specific slots total)
  { name: "VGS_JUNCTION", doc: "JFETvgs — gate-source junction voltage (NR linearization)", init: { kind: "zero" } },
  { name: "GGS_JUNCTION", doc: "JFETggs — gate-source junction conductance",                  init: { kind: "constant", value: GMIN } },
  { name: "CG_JUNCTION",  doc: "JFETcg — gate total current at operating point",              init: { kind: "zero" } },
  // Gate-drain junction (MISSING from pre-fix schema; F5-E fix)
  { name: "VGD_JUNCTION", doc: "JFETvgd — gate-drain junction voltage (NR linearization)",    init: { kind: "zero" } },
  { name: "GGD_JUNCTION", doc: "JFETggd — gate-drain junction conductance",                   init: { kind: "constant", value: GMIN } },
  { name: "CGD_JUNCTION", doc: "JFETcgd — gate-drain junction current",                       init: { kind: "zero" } },
  // Channel drain-current history (for cdhat convergence predictor)
  { name: "CD_CHANNEL",   doc: "JFETcd — drain current (cdrain - cgd) for convergence",       init: { kind: "zero" } },
  // Charge storage
  { name: "QGS_JFET",     doc: "JFETqgs — gate-source junction charge",                       init: { kind: "zero" } },
  { name: "QGD_JFET",     doc: "JFETqgd — gate-drain junction charge",                        init: { kind: "zero" } },
  { name: "CQGS_JFET",    doc: "JFETcqgs — gate-source junction companion current",           init: { kind: "zero" } },
  { name: "CQGD_JFET",    doc: "JFETcqgd — gate-drain junction companion current",            init: { kind: "zero" } },
] as const);
```

**ngspice citation**: `jfetdefs.h` defines `JFETvgs`, `JFETvgd`, `JFETcg`, `JFETcd`, `JFETcgd`, `JFETgm`, `JFETgds`, `JFETggs`, `JFETggd`, `JFETqgs`, `JFETcqgs`, `JFETqgd`, `JFETcqgd` (reflected by references throughout `jfetload.c:104-148, 509-517`).

⚠ **Test-file impact**: `__tests__/jfet.test.ts:19-22` imports `SLOT_GD_JUNCTION` and `SLOT_ID_JUNCTION` which are renamed. Update test imports to `SLOT_GGS_JUNCTION` and `SLOT_CG_JUNCTION` (preferred) or resolve via `stateSchema` (see `feedback_schema_lookups_over_exports.md` in MEMORY.md).

---

### Diff 3.2 — Accessor getters/setters for new slots

**OLD** `njfet.ts:160-167`
```
 160	  protected get _vgs_junction(): number { return this._s0[this.stateBaseOffset + SLOT_VGS_JUNCTION]; }
 161	  protected set _vgs_junction(v: number) { this._s0[this.stateBaseOffset + SLOT_VGS_JUNCTION] = v; }
 162	
 163	  protected get _gd_junction(): number { return this._s0[this.stateBaseOffset + SLOT_GD_JUNCTION]; }
 164	  protected set _gd_junction(v: number) { this._s0[this.stateBaseOffset + SLOT_GD_JUNCTION] = v; }
 165	
 166	  protected get _id_junction(): number { return this._s0[this.stateBaseOffset + SLOT_ID_JUNCTION]; }
 167	  protected set _id_junction(v: number) { this._s0[this.stateBaseOffset + SLOT_ID_JUNCTION] = v; }
```

**NEW**
```ts
  // Gate-source junction (JFETvgs/JFETggs/JFETcg convention from ngspice)
  protected get _vgs_junction(): number { return this._s0[this.stateBaseOffset + SLOT_VGS_JUNCTION]; }
  protected set _vgs_junction(v: number) { this._s0[this.stateBaseOffset + SLOT_VGS_JUNCTION] = v; }

  protected get _ggs_junction(): number { return this._s0[this.stateBaseOffset + SLOT_GGS_JUNCTION]; }
  protected set _ggs_junction(v: number) { this._s0[this.stateBaseOffset + SLOT_GGS_JUNCTION] = v; }

  protected get _cg_total(): number { return this._s0[this.stateBaseOffset + SLOT_CG_JUNCTION]; }
  protected set _cg_total(v: number) { this._s0[this.stateBaseOffset + SLOT_CG_JUNCTION] = v; }

  // Gate-drain junction (JFETvgd/JFETggd/JFETcgd) — F5-E apparatus
  protected get _vgd_junction(): number { return this._s0[this.stateBaseOffset + SLOT_VGD_JUNCTION]; }
  protected set _vgd_junction(v: number) { this._s0[this.stateBaseOffset + SLOT_VGD_JUNCTION] = v; }

  protected get _ggd_junction(): number { return this._s0[this.stateBaseOffset + SLOT_GGD_JUNCTION]; }
  protected set _ggd_junction(v: number) { this._s0[this.stateBaseOffset + SLOT_GGD_JUNCTION] = v; }

  protected get _cgd_junction(): number { return this._s0[this.stateBaseOffset + SLOT_CGD_JUNCTION]; }
  protected set _cgd_junction(v: number) { this._s0[this.stateBaseOffset + SLOT_CGD_JUNCTION] = v; }

  // Drain-current history for cdhat convergence predictor
  protected get _cd_channel(): number { return this._s0[this.stateBaseOffset + SLOT_CD_CHANNEL]; }
  protected set _cd_channel(v: number) { this._s0[this.stateBaseOffset + SLOT_CD_CHANNEL] = v; }
```

**ngspice citation**: Accessor parity with `jfetload.c:509-517` state-slot writebacks (`state0[JFETvgs/JFETvgd/JFETcg/JFETcd/JFETcgd/JFETgm/JFETgds/JFETggs/JFETggd]`).

---

### Diff 3.3 — Delete Vds hard-clamp (F5-D) from `limitVoltages`

**OLD** `njfet.ts:169-186`
```
 169	  limitVoltages(
 170	    vgsOld: number,
 171	    _vdsOld: number,
 172	    vgsNew: number,
 173	    vdsNew: number,
 174	  ): { vgs: number; vds: number; swapped?: boolean } {
 175	    const vt_n = VT * this._p.N;
 176	    const vcrit = vt_n * Math.log(vt_n / (Math.SQRT2 * this._p.IS));
 177	    const vgsResult = pnjlim(vgsNew, vgsOld, vt_n, vcrit);
 178	    this._pnjlimLimited = vgsResult.limited;
 179	
 180	    // Clamp Vds to prevent huge steps
 181	    let vds = vdsNew;
 182	    if (vds < -10) vds = -10;
 183	    if (vds > 50) vds = 50;
 184	
 185	    return { vgs: vgsResult.value, vds, swapped: false };
 186	  }
```

**NEW**
```ts
  /**
   * ngspice jfetload.c:209-242 voltage limiting.
   *
   * jfetload.c applies TWO limiters to BOTH vgs and vgd:
   *   1. DEVpnjlim(v*, state0[JFETv*], temp*CONSTKoverQ, vcrit, &icheck)   — jfetload.c:217,223
   *   2. DEVfetlim(v*, state0[JFETv*], tThreshold)                          — jfetload.c:232,238
   *
   * There is NO Vds limiter in jfetload.c. The Sydney-University-modified
   * JFET model relies on the fetlim-on-vgd to constrain Vds = vgs - vgd.
   *
   * This method is invoked with vgsNew = vgs, vdsNew = vds; the caller in
   * _updateOp MUST separately compute vgdNew = vgs - vds and call limitVgd
   * to apply pnjlim + fetlim on the gate-drain junction. We return only the
   * vgs limit here (vds is recomposed from limited vgs and vgd at the call
   * site), preserving the jfetload.c flow.
   */
  limitVoltages(
    vgsOld: number,
    _vdsOld: number,
    vgsNew: number,
    vdsNew: number,
  ): { vgs: number; vds: number; swapped?: boolean } {
    const vt_n = VT * this._p.N;
    const vcrit = vt_n * Math.log(vt_n / (Math.SQRT2 * this._p.IS));

    // DEVpnjlim on vgs — jfetload.c:217
    const vgsPnj = pnjlim(vgsNew, vgsOld, vt_n, vcrit);
    this._pnjlimLimited = vgsPnj.limited;

    // DEVfetlim on vgs — jfetload.c:232 (second limiter, Sydney-U extension)
    const vgsLimited = fetlim(vgsPnj.value, vgsOld, this._p.VTO);

    // Vds is recomposed by _updateOp from the limited vgs AND vgd; here we
    // pass the raw vds through. The Vds clamp [-10,50] present in the
    // pre-F5 code was a substitute for the missing vgd limiter; removed.
    return { vgs: vgsLimited, vds: vdsNew, swapped: false };
  }

  /**
   * ngspice jfetload.c:222-240 — DEVpnjlim + DEVfetlim on gate-drain junction.
   *
   * Applies the second limiter pair (the one missing from the pre-F5 model).
   * The caller in _updateOp must call this on vgdNew = (vG - vD) read from
   * CKTrhsOld, using vgdOld = state0[JFETvgd].
   *
   * Returns { vgd, limited } where `limited` is the ichk1 bit that gets
   * OR'd into icheck at jfetload.c:227-229.
   */
  protected limitVgd(vgdNew: number, vgdOld: number): { vgd: number; limited: boolean } {
    const vt_n = VT * this._p.N;
    const vcrit = vt_n * Math.log(vt_n / (Math.SQRT2 * this._p.IS));

    const vgdPnj = pnjlim(vgdNew, vgdOld, vt_n, vcrit);
    const vgdLimited = fetlim(vgdPnj.value, vgdOld, this._p.VTO);
    return { vgd: vgdLimited, limited: vgdPnj.limited };
  }
```

Required import addition at `njfet.ts:43`:
```ts
import { pnjlim, fetlim } from "../../solver/analog/newton-raphson.js";
```

**ngspice citation**: `jfetload.c:209-242` (the 4 `{}` blocks calling `DEVpnjlim` + `DEVfetlim` on vgs and vgd, with `ichk1` → `icheck` aggregation at line 227–229).

---

### Diff 3.4 — Rewrite `primeJunctions` with full MODEINITJCT branches (cases 3/4/5)

**OLD** `njfet.ts:258-263`
```
 258	  primeJunctions(): void {
 259	    // jfetload.c:115-118: MODEINITJCT sets vgs=-1, vgd=-1
 260	    this._vgs = -1;
 261	    this._vds = 0;  // vgs - vgd = -1 - (-1) = 0
 262	    this._vgs_junction = -1;
 263	  }
```

**NEW**
```ts
  /**
   * ngspice jfetload.c:109-122 — MODEINITJCT seeding.
   *
   *   Case A (jfetload.c:109-114): MODEINITJCT & MODETRANOP & MODEUIC
   *     vds = JFETtype * ICVDS;   vgs = JFETtype * ICVGS;   vgd = vgs - vds;
   *
   *   Case B (jfetload.c:115-118): MODEINITJCT & !OFF
   *     vgs = -1;   vgd = -1;   (vds = 0 implicit)
   *
   *   Case C (jfetload.c:119-122): (MODEINITJCT) || (MODEINITFIX && OFF)
   *     vgs = 0;   vgd = 0;
   *
   * The `uic` and `off` flags come from LoadContext / model params.
   * Called by dcopModeLadder before iteration 0.
   */
  primeJunctions(opts?: { uic?: boolean; icVgs?: number; icVds?: number; off?: boolean }): void {
    const uic = opts?.uic ?? false;
    const off = opts?.off ?? false;
    const icVgs = opts?.icVgs;
    const icVds = opts?.icVds;
    const polarity = this.polaritySign; // JFETtype

    let vgs: number, vgd: number;
    if (uic && icVgs !== undefined && icVds !== undefined) {
      // Case A: jfetload.c:112-114
      const vds = polarity * icVds;
      vgs = polarity * icVgs;
      vgd = vgs - vds;
    } else if (!off) {
      // Case B: jfetload.c:117-118
      vgs = -1;
      vgd = -1;
    } else {
      // Case C: jfetload.c:121-122
      vgs = 0;
      vgd = 0;
    }

    this._vgs = vgs;
    this._vds = vgs - vgd;        // vds = vgs - vgd per jfetload.c:247
    this._vgs_junction = vgs;      // JFETvgs seed for pnjlim vold on next iter
    this._vgd_junction = vgd;      // JFETvgd seed for pnjlim vold on next iter

    // Zero predicted-current history (cg, cd) so first-iteration cghat/cdhat
    // start from 0 rather than stale state0 noise. jfetload.c does not
    // explicitly zero these during INITJCT; they're naturally zero at cold
    // start because StatePool zero-inits. During a reset-to-DCOP mid-transient
    // we still want them zeroed so the convergence test doesn't fire on
    // stale history — matches ngspice behavior since INITJCT on re-DCOP
    // clears state0 entirely via NIacIter/NIiter reset.
    this._ggs_junction = GMIN;
    this._ggd_junction = GMIN;
    this._cg_total = 0;
    this._cd_channel = 0;
    this._cgd_junction = 0;
  }
```

**ngspice citation**: `jfetload.c:109-122` (three-branch MODEINITJCT seed).

---

### Diff 3.5 — MODEINITPRED block in `_updateOp`: state1→state0 copies + xfact extrapolation for vgs and vgd

**OLD** `njfet.ts:265-285` (the current `_updateOp` head)
```
 265	  protected override _updateOp(ctx: LoadContext): void {
 266	    const voltages = ctx.voltages;
 267	    const limitingCollector = ctx.limitingCollector;
 268	    // jfetload.c: during MODEINITJCT, primeJunctions() has already set _vgs, _vds,
 269	    // _vgs_junction directly. Skip MNA voltage reads and all voltage limiting.
 270	    if (ctx.initMode === "initJct") {
 271	      this._pnjlimLimited = false;
 272	      this._swapped = false;
 273	
 274	      this._ids = this.computeIds(this._vgs, this._vds);
 275	      this._gm = this.computeGm(this._vgs, this._vds);
 276	      this._gds = this.computeGds(this._vgs, this._vds);
 277	
 278	      // Gate junction I-V at primed vgs_junction
 279	      const vt_n = VT * this._p.N;
 280	      const expArg = Math.min(this._vgs_junction / vt_n, 80);
 281	      const igJunction = this._p.IS * (Math.exp(expArg) - 1);
 282	      this._gd_junction = (this._p.IS / vt_n) * Math.exp(expArg) + GMIN;
 283	      this._id_junction = igJunction;
 284	      return;
 285	    }
```

**NEW** (prepended block + reworked remainder — full replacement of `_updateOp`):
```ts
  protected override _updateOp(ctx: LoadContext): void {
    const voltages = ctx.voltages;
    const limitingCollector = ctx.limitingCollector;
    const base = this.stateBaseOffset;
    const s0 = this._s0;
    const s1 = this.s1;
    const s2 = this.s2;

    // --- Step 1: MODEINITPRED — jfetload.c:124-149 (#ifndef PREDICTOR branch) ---
    // Default ngspice build has PREDICTOR undefined, so this branch IS active.
    // Copy 9 state slots from state1 into state0 and extrapolate vgs/vgd
    // via xfact = CKTdelta / CKTdeltaOld[1].
    if (ctx.initMode === "initPred") {
      // xfact per jfetload.c:126. ctx.loadCtx.xfact is already deltaOld[0]/deltaOld[1]
      // which equals CKTdelta/CKTdeltaOld[1] at the moment MODEINITPRED runs
      // (dctran.c sets CKTdelta before MODEINITPRED load).
      const xfact = ctx.xfact;

      // Copy state1 into state0 for vgs/vgd BEFORE extrapolation — jfetload.c:127-148
      const s1Vgs = s1[base + SLOT_VGS];              // JFETvgs from FET_BASE
      const s1Vgd = s1[base + SLOT_VGD_JUNCTION];     // JFETvgd
      s0[base + SLOT_VGS]           = s1Vgs;
      s0[base + SLOT_VGD_JUNCTION]  = s1Vgd;

      // Extrapolate vgs/vgd — jfetload.c:129-134
      const s2Vgs = s2[base + SLOT_VGS];
      const s2Vgd = s2[base + SLOT_VGD_JUNCTION];
      const vgsExtrap = (1 + xfact) * s1Vgs - xfact * s2Vgs;
      const vgdExtrap = (1 + xfact) * s1Vgd - xfact * s2Vgd;

      // Copy the remaining 7 state slots state1 → state0 — jfetload.c:135-148
      s0[base + SLOT_CG_JUNCTION]   = s1[base + SLOT_CG_JUNCTION];    // JFETcg
      s0[base + SLOT_CD_CHANNEL]    = s1[base + SLOT_CD_CHANNEL];     // JFETcd
      s0[base + SLOT_CGD_JUNCTION]  = s1[base + SLOT_CGD_JUNCTION];   // JFETcgd
      s0[base + SLOT_GM]            = s1[base + SLOT_GM];             // JFETgm  (FET_BASE alias)
      s0[base + SLOT_GDS]           = s1[base + SLOT_GDS];            // JFETgds (FET_BASE alias)
      s0[base + SLOT_GGS_JUNCTION]  = s1[base + SLOT_GGS_JUNCTION];   // JFETggs
      s0[base + SLOT_GGD_JUNCTION]  = s1[base + SLOT_GGD_JUNCTION];   // JFETggd

      // Write extrapolated vgs/vgd and derive vds = vgs - vgd (jfetload.c:247)
      this._vgs = vgsExtrap;
      this._vgd_junction = vgdExtrap;
      this._vgs_junction = vgsExtrap;    // vgs_junction tracks vgs for pnjlim vold
      this._vds = vgsExtrap - vgdExtrap;
      this._swapped = false;
      this._pnjlimLimited = false;
      return;
    }

    // --- Step 2: MODEINITSMSIG — jfetload.c:103-105 ---
    // Read vgs/vgd from state0 (previously-converged values), then fall
    // through to I-V evaluation. The MODEINITSMSIG `continue` at
    // jfetload.c:466 is handled in the charge-storage block, not here.
    if (ctx.initMode === "initSmsig") {
      this._vgs          = s0[base + SLOT_VGS];
      this._vgd_junction = s0[base + SLOT_VGD_JUNCTION];
      this._vgs_junction = s0[base + SLOT_VGS_JUNCTION];
      this._vds          = this._vgs - this._vgd_junction;
      this._swapped = false;
      this._pnjlimLimited = false;
      // Fall through to Shockley diode + Sydney I-V evaluation below.
    }
    // --- Step 3: MODEINITTRAN — jfetload.c:106-108 ---
    else if (ctx.initMode === "initTran") {
      const s1Vgs = s1[base + SLOT_VGS];
      const s1Vgd = s1[base + SLOT_VGD_JUNCTION];
      this._vgs          = s1Vgs;
      this._vgd_junction = s1Vgd;
      this._vgs_junction = s1Vgs;
      this._vds          = s1Vgs - s1Vgd;
      this._swapped = false;
      this._pnjlimLimited = false;
      // Fall through to limiting + I-V evaluation below (jfetload.c continues).
    }
    // --- Step 4: MODEINITJCT — primeJunctions has already seeded _vgs, _vgd_junction ---
    else if (ctx.initMode === "initJct") {
      this._pnjlimLimited = false;
      this._swapped = false;
      // _vgs, _vds, _vgs_junction, _vgd_junction already set by primeJunctions.
      // No pnjlim/fetlim during INITJCT (jfetload.c falls straight through to I-V).
      // Compute DC current + junction diodes and return.
      this._evaluateDc(ctx);
      return;
    }
    else {
      // --- Step 5: Floating / INITFIX / INITFLOAT — jfetload.c:151-164 ---
      // Read vgs/vgd FRESHLY from node voltages (CKTrhsOld proxy = ctx.voltages).
      // ngspice computes vgd from G and D nodes, NOT as vgs - vds — per
      // jfetload.c:158-161. Match that exactly.
      const nodeG = this.gateNode;
      const nodeD = this.drainNode;
      const nodeS = this.sourceNode;
      const vG = nodeG > 0 ? voltages[nodeG - 1] : 0;
      const vD = nodeD > 0 ? voltages[nodeD - 1] : 0;
      const vS = nodeS > 0 ? voltages[nodeS - 1] : 0;
      const polarity = this.polaritySign; // JFETtype

      let vgsRaw = polarity * (vG - vS);
      let vgdRaw = polarity * (vG - vD);    // read independently per jfetload.c:158-161

      // --- Step 6: delvgs/delvgd/delvds/cghat/cdhat — jfetload.c:165-174 ---
      const vgsOld = s0[base + SLOT_VGS];
      const vgdOld = s0[base + SLOT_VGD_JUNCTION];
      const delvgs = vgsRaw - vgsOld;
      const delvgd = vgdRaw - vgdOld;
      const delvds = delvgs - delvgd;
      const cghat = s0[base + SLOT_CG_JUNCTION]
                  + s0[base + SLOT_GGD_JUNCTION] * delvgd
                  + s0[base + SLOT_GGS_JUNCTION] * delvgs;
      const cdhat = s0[base + SLOT_CD_CHANNEL]
                  + s0[base + SLOT_GM]  * delvgs
                  + s0[base + SLOT_GDS] * delvds
                  - s0[base + SLOT_GGD_JUNCTION] * delvgd;

      // Bypass (CKTbypass) — jfetload.c:175-208. We currently do not expose
      // CKTbypass through LoadContext; bypass is gated off by default in
      // ngspice too unless `.options bypass=1`. Skip the bypass block
      // intentionally — it's an optimization, not a convergence mechanism.
      // (If CKTbypass becomes available later, gate this block on it.)

      // --- Step 7: Apply pnjlim + fetlim on vgs and vgd — jfetload.c:209-242 ---
      const lim = this.limitVoltages(vgsOld, this._vds, vgsRaw, vgdRaw /*vds placeholder, unused*/);
      const vgsLimited = lim.vgs;
      // icheck bit from vgs pnjlim:
      const icheckVgs = this._pnjlimLimited;

      const vgdLim = this.limitVgd(vgdRaw, vgdOld);
      const vgdLimited = vgdLim.vgd;
      // ichk1 aggregation — jfetload.c:227-229: if ichk1==1 then icheck=1.
      const icheck = icheckVgs || vgdLim.limited;
      this._pnjlimLimited = icheck;

      if (limitingCollector) {
        limitingCollector.push({
          elementIndex: this.elementIndex ?? -1,
          label: this.label ?? "",
          junction: "GS",
          limitType: "pnjlim",
          vBefore: vgsRaw,
          vAfter: vgsLimited,
          wasLimited: icheckVgs,
        });
        limitingCollector.push({
          elementIndex: this.elementIndex ?? -1,
          label: this.label ?? "",
          junction: "GD",
          limitType: "pnjlim",
          vBefore: vgdRaw,
          vAfter: vgdLimited,
          wasLimited: vgdLim.limited,
        });
      }

      // Store limited voltages — vds = vgs - vgd per jfetload.c:247
      this._vgs          = vgsLimited;
      this._vgd_junction = vgdLimited;
      this._vgs_junction = vgsLimited;
      this._vds          = vgsLimited - vgdLimited;
      this._swapped = false;

      // Stash cghat/cdhat for the element-local convergence test (see checkConvergence)
      this._lastCghat = cghat;
      this._lastCdhat = cdhat;
    }

    // --- Step 8: DC current + junction diodes + convergence bookkeeping ---
    this._evaluateDc(ctx);

    if (this._pnjlimLimited) ctx.noncon.value++;
  }

  /**
   * Extracted DC evaluation: evaluates both gate junctions (jfetload.c:249-272),
   * the Sydney-University Shichman-Hodges channel (jfetload.c:274-348), the
   * cd = cdrain - cgd combination (jfetload.c:424), and writes all 9 state0
   * slots per jfetload.c:509-517.
   */
  protected _evaluateDc(_ctx: LoadContext): void {
    const base = this.stateBaseOffset;
    const s0 = this._s0;
    const vgs = this._vgs;
    const vgd = this._vgd_junction;
    const vds = vgs - vgd;
    const vt_n = VT * this._p.N;
    const csat = this._p.IS; // area=1 in our abstraction

    // --- Gate-source Shockley diode with -3*vt_temp cubic tail — jfetload.c:250-259 ---
    let cg: number, ggs: number;
    if (vgs < -3 * vt_n) {
      let arg = 3 * vt_n / (vgs * Math.E);
      arg = arg * arg * arg;
      cg = -csat * (1 + arg) + GMIN * vgs;
      ggs = csat * 3 * arg / vgs + GMIN;
    } else {
      const evgs = Math.exp(Math.min(vgs / vt_n, 80));
      ggs = csat * evgs / vt_n + GMIN;
      cg = csat * (evgs - 1) + GMIN * vgs;
    }

    // --- Gate-drain Shockley diode (F5-E) — jfetload.c:261-270 ---
    let cgd: number, ggd: number;
    if (vgd < -3 * vt_n) {
      let arg = 3 * vt_n / (vgd * Math.E);
      arg = arg * arg * arg;
      cgd = -csat * (1 + arg) + GMIN * vgd;
      ggd = csat * 3 * arg / vgd + GMIN;
    } else {
      const evgd = Math.exp(Math.min(vgd / vt_n, 80));
      ggd = csat * evgd / vt_n + GMIN;
      cgd = csat * (evgd - 1) + GMIN * vgd;
    }

    // cg sums both junctions — jfetload.c:272
    cg = cg + cgd;

    // --- Channel drain current (Sydney-U Shichman-Hodges) — jfetload.c:274-348 ---
    // NOTE: the current code in this.computeIds/computeGm/computeGds uses the
    // ORIGINAL ngspice equations (jfetload.c:350-419 `#ifdef notdef`), not the
    // Sydney-U modification. Surfaced as CONV-9. Full port in the
    // "Additional divergences" appendix. Here we invoke the existing methods
    // to preserve the current diff's scope but flag that this is NOT
    // ngspice-aligned until CONV-9 is fixed.
    const cdrain = this.computeIds(vgs, vds);
    const gm = this.computeGm(vgs, vds);
    const gds = this.computeGds(vgs, vds);

    // cd = cdrain - cgd — jfetload.c:424
    const cd = cdrain - cgd;

    // --- Write all 9 state0 slots — jfetload.c:509-517 ---
    s0[base + SLOT_VGS]           = vgs;
    s0[base + SLOT_VGD_JUNCTION]  = vgd;
    s0[base + SLOT_CG_JUNCTION]   = cg;
    s0[base + SLOT_CD_CHANNEL]    = cd;
    s0[base + SLOT_CGD_JUNCTION]  = cgd;
    s0[base + SLOT_GM]            = gm;
    s0[base + SLOT_GDS]           = gds;
    s0[base + SLOT_GGS_JUNCTION]  = ggs;
    s0[base + SLOT_GGD_JUNCTION]  = ggd;
    s0[base + SLOT_IDS]           = cdrain;
    s0[base + SLOT_VDS]           = vds;

    // Operating-point for stamp() — keep protected fields consistent
    this._ids = cdrain;
    this._gm = gm;
    this._gds = gds;
  }
```

Required field additions (for `checkConvergence`):
```ts
  // Predicted current history for jfetload.c:500-504 convergence test
  protected _lastCghat = 0;
  protected _lastCdhat = 0;
```

**ngspice citation**: `jfetload.c:103-174` (all init-mode branches + delta/cghat/cdhat), `jfetload.c:209-242` (both limiter calls on both junctions with icheck/ichk1 aggregation), `jfetload.c:247-272` (vds=vgs-vgd + gate diodes), `jfetload.c:509-517` (state writeback).

---

### Diff 3.6 — JFET-specific `checkConvergence` (replace the inherited MOS1convTest)

**OLD**: Currently inherited from `AbstractFetElement.checkConvergence` (fet-base.ts:399–470). Uses `SLOT_VSB`, `SLOT_VBD`, `SLOT_GBD`, `SLOT_CBD_I`, `SLOT_GBS`, `SLOT_CBS_I`, `SLOT_GMBS` — none meaningful for JFET.

**NEW** — add to `NJfetAnalogElement` class body (e.g. after `primeJunctions`):
```ts
  /**
   * ngspice jfetload.c:498-508 JFET-local convergence test.
   *
   * Overrides the inherited MOS1convTest from AbstractFetElement, which
   * reads SLOT_VBD / SLOT_GBD / SLOT_CBD_I — MOSFET-specific bulk-junction
   * slots that have no meaning for a JFET.
   *
   * Returns false (non-converged) if ANY of:
   *   - icheck == 1  (either vgs or vgd was pnjlim-limited this iteration)
   *   - |cghat - cg| >= reltol*max(|cghat|,|cg|) + abstol
   *   - |cdhat - cd| >  reltol*max(|cdhat|,|cd|) + abstol
   *
   * cghat and cdhat are computed in _updateOp from the previous state0
   * and delvgs/delvgd; cg and cd are the freshly-evaluated operating-point
   * currents written at state0[JFETcg] / state0[JFETcd].
   *
   * The asymmetric `>=` vs `>` on the two currents matches ngspice literal
   * (jfetload.c:501 uses `>=`; line 503 uses `>`).
   */
  override checkConvergence(ctx: LoadContext): boolean {
    if (this._pnjlimLimited) return false; // icheck == 1

    const base = this.stateBaseOffset;
    const s0 = this._s0;
    const cg = s0[base + SLOT_CG_JUNCTION];
    const cd = s0[base + SLOT_CD_CHANNEL];
    const cghat = this._lastCghat;
    const cdhat = this._lastCdhat;

    const reltol = ctx.reltol;
    const abstol = ctx.iabstol;

    const tolG = reltol * Math.max(Math.abs(cghat), Math.abs(cg)) + abstol;
    const tolD = reltol * Math.max(Math.abs(cdhat), Math.abs(cd)) + abstol;

    // jfetload.c:501 — asymmetric >= on cg
    if (Math.abs(cghat - cg) >= tolG) return false;
    // jfetload.c:503 — asymmetric > on cd
    if (Math.abs(cdhat - cd) > tolD) return false;

    return true;
  }
```

Then register `checkConvergence` into `elementsWithConvergence` via the element-registration path (the existing MOSFET-style flow already picks up `checkConvergence` via the base class — the override is enough).

**ngspice citation**: `jfetload.c:498-508` literal.

---

### Diff 3.7 — Update `_stampNonlinear` to include gate-drain diode Norton and use the 16 matrix stamps + 3 RHS stamps from `jfetload.c:521-550`

**OLD** `njfet.ts:349-387`
```
 349	  protected override _stampNonlinear(solver: SparseSolver): void {
 350	    // Stamp channel current (from base class logic with polarity=1)
 351	    const nodeG = this.gateNode;
 352	    const nodeD = this.drainNode;
 353	    const nodeS = this.sourceNode;
 354	
 355	    const gmS = this._gm;
 356	    const gdsS = this._gds;
 357	
 358	    // Transconductance gm
 359	    stampG(solver, nodeD, nodeG, gmS);
 360	    stampG(solver, nodeD, nodeS, -gmS);
 361	    stampG(solver, nodeS, nodeG, -gmS);
 362	    stampG(solver, nodeS, nodeS, gmS);
 363	
 364	    // Output conductance gds
 365	    stampG(solver, nodeD, nodeD, gdsS);
 366	    stampG(solver, nodeD, nodeS, -gdsS);
 367	    stampG(solver, nodeS, nodeD, -gdsS);
 368	    stampG(solver, nodeS, nodeS, gdsS);
 369	
 370	    // Norton current (channel)
 371	    const nortonId = (this._ids - this._gm * this._vgs - this._gds * this._vds);
 372	    stampRHS(solver, nodeD, -nortonId);
 373	    stampRHS(solver, nodeS, nortonId);
 374	
 375	    // Gate junction diode Norton equivalent (between G and S)
 376	    const gd = this._gd_junction;
 377	    const nortonIg = (this._id_junction - this._gd_junction * this._vgs_junction);
 378	
 379	    stampG(solver, nodeG, nodeG, gd);
 380	    stampG(solver, nodeG, nodeS, -gd);
 381	    stampG(solver, nodeS, nodeG, -gd);
 382	    stampG(solver, nodeS, nodeS, gd);
 383	
 384	    stampRHS(solver, nodeG, -nortonIg);
 385	    stampRHS(solver, nodeS, nortonIg);
 386	  }
```

**NEW** (port of `jfetload.c:521-550`):
```ts
  protected override _stampNonlinear(solver: SparseSolver): void {
    const base = this.stateBaseOffset;
    const s0 = this._s0;

    // Our JFET does not have internal source/drain resistances yet (RS/RD
    // stamped as separate linear resistors), so sourcePrime == source and
    // drainPrime == drain. When RS/RD are added, split nodes here to match
    // jfetload.c's drainPrimeNode/sourcePrimeNode distinction.
    const nodeG = this.gateNode;
    const nodeD = this.drainNode;
    const nodeS = this.sourceNode;
    const polarity = this.polaritySign; // JFETtype; =1 for NJFET

    // Read ngspice-identical values from state0 — jfetload.c:525-527
    const cg  = s0[base + SLOT_CG_JUNCTION];
    const cd  = s0[base + SLOT_CD_CHANNEL];
    const cgd = s0[base + SLOT_CGD_JUNCTION];
    const gm  = s0[base + SLOT_GM];
    const gds = s0[base + SLOT_GDS];
    const ggs = s0[base + SLOT_GGS_JUNCTION];
    const ggd = s0[base + SLOT_GGD_JUNCTION];
    const vgs = this._vgs;
    const vgd = this._vgd_junction;
    const vds = this._vds;

    // RHS equivalent currents — jfetload.c:525-527
    const ceqgd = polarity * (cgd - ggd * vgd);
    const ceqgs = polarity * ((cg - cgd) - ggs * vgs);
    const cdreq = polarity * ((cd + cgd) - gds * vds - gm * vgs);

    // RHS stamps — jfetload.c:528-532 (assume m=1)
    stampRHS(solver, nodeG, -ceqgs - ceqgd);
    stampRHS(solver, nodeD, -cdreq + ceqgd);
    stampRHS(solver, nodeS,  cdreq + ceqgs);

    // Y-matrix stamps — jfetload.c:536-550 (16 entries, assume m=1)
    // We omit gdpr/gspr because those are the drain/source ohmic resistors
    // (separate linear-resistor stamps in our model). The remaining 12
    // entries depend only on gm, gds, ggs, ggd.
    stampG(solver, nodeG, nodeD, -ggd);                          // gateDrainPrimePtr
    stampG(solver, nodeG, nodeS, -ggs);                          // gateSourcePrimePtr
    stampG(solver, nodeD, nodeG,  gm - ggd);                     // drainPrimeGatePtr
    stampG(solver, nodeD, nodeS, -gds - gm);                     // drainPrimeSourcePrimePtr
    stampG(solver, nodeS, nodeG, -ggs - gm);                     // sourcePrimeGatePtr
    stampG(solver, nodeS, nodeD, -gds);                          // sourcePrimeDrainPrimePtr
    stampG(solver, nodeG, nodeG,  ggd + ggs);                    // gateGatePtr
    stampG(solver, nodeD, nodeD,  gds + ggd);                    // drainPrimeDrainPrimePtr (less gdpr)
    stampG(solver, nodeS, nodeS,  gds + gm + ggs);               // sourcePrimeSourcePrimePtr (less gspr)
  }
```

**ngspice citation**: `jfetload.c:521-550` verbatim (with `gdpr`/`gspr` deferred to linear RS/RD resistors).

---

## Deliverable 4 — Concrete diff for `pjfet.ts`

PJFET inherits from NJFET, so all state-slot/schema/`_evaluateDc`/`checkConvergence`/`primeJunctions` infrastructure is inherited automatically by the Diff 3.x changes. Only the polarity-specific overrides need updating.

### Diff 4.1 — Delete Vds hard-clamp (F5-D)

**OLD** `pjfet.ts:89-106`
```
  89	  override limitVoltages(
  90	    vgsOld: number,
  91	    _vdsOld: number,
  92	    vgsNew: number,
  93	    vdsNew: number,
  94	  ): { vgs: number; vds: number; swapped?: boolean } {
  95	    // For P-JFET, apply pnjlim on the sign-inverted gate junction
  96	    const vt_n = VT * this._p.N;
  97	    const vcrit = vt_n * Math.log(vt_n / (Math.SQRT2 * this._p.IS));
  98	    const vgsResult = pnjlim(vgsNew, vgsOld, vt_n, vcrit);
  99	    this._pnjlimLimited = vgsResult.limited;
 100	
 101	    let vds = vdsNew;
 102	    if (vds < -50) vds = -50;
 103	    if (vds > 10) vds = 10;
 104	
 105	    return { vgs: vgsResult.value, vds, swapped: false };
 106	  }
```

**NEW**: **Delete this method entirely**. The inherited `NJfetAnalogElement.limitVoltages` (Diff 3.3) applies pnjlim + fetlim on the polarity-normalized `vgsOld/vgsNew`, which is correct for both NJFET (polarity=+1) and PJFET (polarity=-1) since the caller in `_updateOp` converts raw node voltages to polarity-normalized device voltages BEFORE invoking the limiter. VTO in `this._p.VTO` is stored per polarity (+2 for PJFET, -2 for NJFET) and is passed to `fetlim` as-is, matching ngspice's handling (fetlim takes `tThreshold` which is already polarity-aware via `JFETtype * JFETthreshold` in tempsetup).

(If verification reveals that `this._p.VTO` is NOT polarity-aware in the current codebase — which the PJFET default at `pjfet.ts:56` suggests (VTO=+2 is positive), while ngspice would expect `JFETtype * VTO = -1 * 2 = -2` passed to fetlim — the shared `limitVoltages` in Diff 3.3 must invert VTO using `this.polaritySign * this._p.VTO` before passing to `fetlim`. Surfaced as **CONV-13** below.)

### Diff 4.2 — Rewrite `_updateOp` to delegate to the polarity-aware base implementation

**OLD** `pjfet.ts:115-197` — the full `override _updateOp` method.

**NEW**: **Delete this method entirely**. The Diff 3.5 base `_updateOp` uses `this.polaritySign` at node-voltage read (`vgs = polarity*(vG-vS)`, `vgd = polarity*(vG-vD)`) to produce polarity-normalized device voltages, which is the ngspice-correct approach (`vgs = JFETtype*(rhsOld[gate] - rhsOld[sourcePrime])` per jfetload.c:154-157). No PJFET-specific updateOp is needed.

### Diff 4.3 — Rewrite `_stampNonlinear` to delegate to the polarity-aware base implementation

**OLD** `pjfet.ts:199-243` — the full `override _stampNonlinear` method.

**NEW**: **Delete this method entirely**. The Diff 3.7 base `_stampNonlinear` applies `const polarity = this.polaritySign` at RHS construction (`ceqgd = polarity * (cgd - ggd*vgd)` etc.), which is literal ngspice (`ceqgd = model->JFETtype * (cgd - ggd*vgd)` at jfetload.c:525). No polarity-specific stamp override is needed.

### Diff 4.4 — Rewrite `primeJunctions` to delegate

**OLD** `pjfet.ts:108-113`
```
 108	  override primeJunctions(): void {
 109	    // jfetload.c:115-118: MODEINITJCT sets vgs=-1, vgd=-1 (polarity handled at voltage-read time)
 110	    this._vgs = -1;
 111	    this._vds = 0;  // vgs - vgd = -1 - (-1) = 0
 112	    this._vgs_junction = -1;
 113	  }
```

**NEW**: **Delete this method entirely**. The Diff 3.4 base `primeJunctions` handles all three MODEINITJCT branches including polarity application for MODEUIC.

### Net PJFET diff result

After 4.1–4.4, `PJfetAnalogElement` reduces to:
```ts
export class PJfetAnalogElement extends NJfetAnalogElement {
  override readonly polaritySign: 1 | -1 = -1;
  // All behavior inherited — ngspice JFETtype handling is parameter-driven.
}
```

**ngspice citation**: `jfetload.c:154-164` (polarity at voltage read), `jfetload.c:525-532` (polarity at RHS).

---

## Deliverable 5 — Additional divergences surfaced (F5-ext)

### CONV-9 — Drain-current equations use `#ifdef notdef` original Shichman-Hodges, not Sydney-University model

**ngspice**: `jfetload.c:274-348` — Sydney-University model with `JFETbFac`, `apart = 2*b + 3*Bfac*(vgst-vds)`, `cpart = vds*(vds*(Bfac*vds - b) + vgst*apart)`, `cdrain = betap*cpart`, with distinct linear/saturation branches using the `apart`/`cpart` decomposition.

**Ours**: `njfet.ts:188-248` — uses the simple `cdrain = beta*vds*(2*vgst - vds)*(1+lambda*vds)` (linear) / `cdrain = (beta/2)*vgst^2*(1+lambda*vds)` (sat) — this matches ngspice's `#ifdef notdef` block (`jfetload.c:350-419`), NOT the live Sydney-U block.

**Impact**: Any JFET with non-default `B`/`BFAC` (or under large-signal operation) will diverge from ngspice starting at iteration 0.

**Fix required**: Port `jfetload.c:274-348` verbatim to `computeIds`/`computeGm`/`computeGds`. Add `B`, `BFAC` to `JfetParams` (`jfetdefs.h` JFETmodel fields: `JFETb`, `JFETbFac`, `JFETlModulation`). Produce distinct normal-mode / inverse-mode branches rather than dispatching on `vds < vgst` alone.

### CONV-10 — Gate-diode cutoff uses `exp(min(v/vt, 80))` clamp instead of `-3*vt_temp` cubic tail

**ngspice**: `jfetload.c:250-254`:
```c
if (vgs < -3*vt_temp) {
    arg = 3*vt_temp/(vgs*CONSTe);
    arg = arg * arg * arg;
    cg = -csat*(1+arg) + ckt->CKTgmin*vgs;
    ggs = csat*3*arg/vgs + ckt->CKTgmin;
}
```

**Ours**: `njfet.ts:280-283, 341-344` — uses `expArg = Math.min(vgs/vt_n, 80)` and `csat*(exp(expArg)-1)`. At deep reverse bias (vgs < -3*vt_n ≈ -0.08 V), the ngspice form produces a smooth cubic tail with analytically-matched derivative; our form produces `ggs = (csat/vt_n)*exp(-3) + GMIN ≈ 0.05*csat/vt_n`, which is wrong in both magnitude and derivative sign.

**Fix required**: Port `jfetload.c:250-270` verbatim (for BOTH vgs and vgd) — the Diff 3.5 `_evaluateDc` already reflects this. Confirm adoption.

### CONV-11 — Bypass block (jfetload.c:175-208) not implemented

**ngspice**: CKTbypass-gated short-circuit that skips device evaluation when delvgs/delvgd/cghat-cg/cdhat-cd are all within tolerance. Drops straight to `goto load`.

**Ours**: Not implemented.

**Impact**: When `.options bypass=1` is set, ngspice runs faster on converged operating points; we don't. Since bypass is a PERFORMANCE optimization gated on CKTbypass (ngspice default: on in some builds, off in others), this is **not a correctness divergence** but is a per-iteration cost we pay. Flag as future work only if the harness parity tests are slowed by this.

### CONV-12 — MODEINITSMSIG charge-storage `continue` path

**ngspice**: `jfetload.c:461-467`:
```c
if (ckt->CKTmode & MODEINITSMSIG) {
    *(ckt->CKTstate0 + here->JFETqgs) = capgs;
    *(ckt->CKTstate0 + here->JFETqgd) = capgd;
    continue; /*go to 1000*/
}
```

The MODEINITSMSIG pass stores `capgs` and `capgd` (small-signal capacitances at the operating point) into the QGS/QGD slots in place of the transient-integrated charges, then skips ALL remaining stamping via `continue`.

**Ours**: No MODEINITSMSIG handling. AC analysis will read transient-integrated charges rather than small-signal capacitances.

**Fix required**: Add the MODEINITSMSIG `continue` path in `_updateOp` (skip stamping) and a charge-storage path that evaluates `capgs`/`capgd` from `czgs`/`czgd`, `corDepCap`, `f1`/`f2`/`f3` per `jfetload.c:430-456`. This is missing infrastructure — NJFET has `CGS` and `CGD` as zero-bias constants only, no depletion-capacitance scaling with vgs/vgd.

### CONV-13 — `fetlim` receives unpolarized VTO

When calling `fetlim(vgsLimited, vgsOld, this._p.VTO)` in Diff 3.3, PJFET `this._p.VTO = +2.0` (per `pjfet.ts:56`), but ngspice `jfetload.c:233` calls `DEVfetlim(vgs, ..., here->JFETtThreshold)` where `JFETtThreshold = JFETtype * JFETthreshold`. For PJFET: `JFETtype=-1`, so `JFETtThreshold = -VTO`.

**Fix required**: In shared `limitVoltages`, use `const vto = this.polaritySign * this._p.VTO` before passing to fetlim. Update Diff 3.3 accordingly.

### CONV-14 — Stamping swaps nodes unnecessarily (AbstractFetElement._swapped)

**AbstractFetElement** supports a `_swapped` flag (`fet-base.ts:225`) for MOSFET source/drain role reversal on `vds < 0`. JFET's Sydney-U equations handle both `vds >= 0` (normal mode) and `vds < 0` (inverse mode) natively in a single branch — no physical swap is done. ngspice `jfetload.c:523-550` stamps with `drainPrimeNode` and `sourcePrimeNode` fixed to the original device assignments regardless of sign of vds. Our JFET `_stampNonlinear` in Diff 3.7 also keeps nodes fixed. Confirm that `_swapped` is never set to true in JFET `_updateOp` (Diff 3.5 already sets `this._swapped = false` in every branch).

### CONV-15 — getPinCurrents assumes swappable MOSFET convention

**AbstractFetElement.getPinCurrents** at `fet-base.ts:379-397` uses `this._swapped ? -ids : ids` — correct for the JFET-always-false case, but the value of `_ids` stored is `cdrain` (pre-diode-subtraction), not ngspice's `cd` (post-subtraction). ngspice reports `cd = cdrain - cgd` at each terminal. For small IS this is negligible; for forward-biased gate diodes it diverges.

**Fix required**: Override `getPinCurrents` in NJFET to return `polarity*cd` at drain, `polarity*(cd+cgd)+polarity*(ceqgs)` at source, and `polarity*(-cg)` at gate. Or — cleaner — set `this._ids = cd` rather than `cdrain` (Diff 3.5 currently assigns cdrain; change to cd).

### CONV-16 — No MODEINITFIX handling distinct from MODEINITJCT

**ngspice**: `jfetload.c:119-122` combines MODEINITJCT and MODEINITFIX (with OFF) into the `vgs=0, vgd=0` branch. The INITFIX-without-OFF path falls through to the FLOATING branch reading rhsOld.

**Ours**: `primeJunctions` in Diff 3.4 handles OFF but does NOT distinguish INITFIX from INITJCT. In the current NR flow (newton-raphson.ts:474-489) INITJCT transitions to INITFIX after iteration 0, then a second cold-start load runs under `initFix`. Our code would fall into the `else` floating branch under `initFix` and read `ctx.voltages` which at that point contains the INITJCT solution — same as ngspice MODEINITFIX-non-OFF. **No fix required**, but the INITFIX+OFF=true case is unhandled (we have no OFF param yet → see CONV-17).

### CONV-17 — No `JFEToff` parameter in JfetParams

**ngspice**: `jfetdefs.h` `JFEToff` (short for "off at start") — forces the device off during MODEINITJCT/MODEINITFIX regardless of other flags. See jfetload.c:116, 120.

**Ours**: No `OFF` field in `JfetParams`. All JFETs treated as `OFF==0`.

**Fix required**: Add `OFF: boolean` to JfetParams, expose via attribute mapping, thread through `primeJunctions(opts)`.

### CONV-18 — No ICVGS / ICVDS instance parameters

**ngspice**: `jfetdefs.h` `JFETicVGS`, `JFETicVDS` — initial-condition voltages for MODEUIC startup. Used at `jfetload.c:112-114`.

**Ours**: Not implemented.

**Fix required**: Add to JfetParams + attributeMap, thread through `primeJunctions(opts)`.

### CONV-19 — Pin-node stamping assumes RS == RD == 0

**ngspice**: jfetload.c distinguishes `JFETdrainNode` (external) from `JFETdrainPrimeNode` (internal) with `JFETdrainDrainPtr`, `JFETdrainPrimeDrainPtr`, `JFETdrainDrainPrimePtr` stamping `gdpr = 1/RD` at the external↔internal resistance. Same for source.

**Ours**: No internal drain-prime / source-prime nodes. RD / RS parameters are declared in `NJFET_PARAM_DEFS` (`njfet.ts:90-91`) but NEVER stamped. They are silently ignored by the compiler.

**Fix required**: Either (a) synthesize internal prime nodes in the compiler when RD>0 or RS>0 (mirror ngspice's conditional `DEFNMOS` node allocation), or (b) remove RD/RS from the param defs entirely and document that jfetload.c's gdpr/gspr stamps are deferred to external resistor primitives. Either is a significant change; ngspice's approach (a) is the canonical one.

### CONV-20 — Charge storage (`JFETqgs` / `JFETqgd` / NIintegrate) absent

**ngspice**: `jfetload.c:425-494` evaluates `czgs`, `czgd`, `fcpb2`, `czgsf2`, `czgdf2`, computes `capgs`, `capgd` via piecewise depletion-capacitance formula (below/above `corDepCap`), then `NIintegrate` at lines 477 and 481 for both junctions. Augments `ggs += geq`, `ggd += geq`, `cg += cqgs + cqgd`, `cd -= cqgd`, `cgd += cqgd`.

**Ours**: In transient mode, reactive stamping is handled by `AbstractFetElement._stampCompanion` / `_stampReactiveCompanion` with a CONSTANT CGS and CGD (`computeCapacitances` returns `{cgs: this._p.CGS, cgd: this._p.CGD}` at njfet.ts:250-252). This is the Meyer model with zero-bias caps, NOT the depletion-capacitance model in jfetload.c:425-456.

**Fix required**: Replace `computeCapacitances` with the ngspice piecewise form:
```
if (v < corDepCap):   q = twop*cz*(1 - sqrt(1 - v/tGatePot));  cap = cz/sqrt(1 - v/tGatePot)
else:                 q = cz*f1 + czf2*(f3*(v - corDepCap) + (v^2 - fcpb2)/(twop+twop))
                      cap = czf2*(f3 + v/twop)
```
Additionally, port the MODEINITTRAN copy-back at `jfetload.c:487-492` (state1[cqgs] = state0[cqgs]).

### CONV-21 — Slot naming legacy (`GD_JUNCTION` / `ID_JUNCTION`)

As surfaced in Deliverable 2 — `SLOT_GD_JUNCTION = 46` holds the gate-SOURCE junction conductance, not gate-DRAIN. `SLOT_ID_JUNCTION = 47` holds the gate-source junction current. The Diff 3.1 schema rename to `SLOT_GGS_JUNCTION` / `SLOT_CG_JUNCTION` fixes this, but **will break the existing test imports at `jfet.test.ts:19-22`**. Update tests by resolving slot names via `stateSchema.getSlotOffset("GGS_JUNCTION")` per MEMORY.md `feedback_schema_lookups_over_exports`.

### CONV-22 — Temperature dependence absent

**ngspice**: `jfetload.c:95-98` uses `JFETtBeta`, `JFETtSatCur`, `JFETtGatePot`, `JFETtCGS`, `JFETtCGD`, `JFETcorDepCap`, `JFETtThreshold`, `JFETvcrit`, `JFETtemp*CONSTKoverQ`. These are set in `jfettemp.c` via temperature-scaling from TNOM values.

**Ours**: No temperature scaling. `TNOM` is declared (`njfet.ts:94`) but unused. `VT` is hardcoded to 300 K. `IS`, `BETA`, `PB`, `CGS`, `CGD` are used literally without T-scaling.

**Fix required**: Add a `jfettemp`-equivalent pre-solve pass that populates temperature-scaled params. Touches `JfetParams` structurally.

### State-slot layout differences (summary)

| ngspice slot | Our slot (pre-fix) | Our slot (post-Diff 3.1) |
|---|---|---|
| JFETvgs | SLOT_VGS (FET_BASE) | SLOT_VGS (FET_BASE) |
| JFETvgd | — MISSING | SLOT_VGD_JUNCTION (48) |
| JFETcg  | SLOT_ID_JUNCTION (47, misnamed) | SLOT_CG_JUNCTION (47) |
| JFETcd  | — MISSING | SLOT_CD_CHANNEL (51) |
| JFETcgd | — MISSING | SLOT_CGD_JUNCTION (50) |
| JFETgm  | SLOT_GM (FET_BASE) | SLOT_GM (FET_BASE) |
| JFETgds | SLOT_GDS (FET_BASE) | SLOT_GDS (FET_BASE) |
| JFETggs | SLOT_GD_JUNCTION (46, misnamed) | SLOT_GGS_JUNCTION (46) |
| JFETggd | — MISSING | SLOT_GGD_JUNCTION (49) |
| JFETqgs | — MISSING (gate-cap stored via FET_BASE SLOT_Q_GS, Meyer, wrong formula) | SLOT_QGS_JFET (52) |
| JFETqgd | — MISSING | SLOT_QGD_JFET (53) |
| JFETcqgs | — MISSING | SLOT_CQGS_JFET (54) |
| JFETcqgd | — MISSING | SLOT_CQGD_JFET (55) |

### Stamping-order differences (summary)

ngspice jfetload.c orders stamps as: **RHS first** (`ceqgs`, `ceqgd`, `cdreq` at nodeG/nodeD/nodeS), then **Y-matrix** (16 entries in the exact order listed at jfetload.c:536-550). Our pre-fix code orders: channel gm first, channel gds, channel Norton RHS, then gate-source diode Y+RHS. Order-of-stamping does not affect the final matrix (stamping is commutative additive), so this is a cosmetic divergence, not a correctness one. Diff 3.7 matches ngspice's RHS-first-then-Y ordering for readability.

---

## References

- `C:\local_working_projects\digital_in_browser\ref\ngspice\src\spicelib\devices\jfet\jfetload.c:1-555` — source of truth for the port
- `C:\local_working_projects\digital_in_browser\src\components\semiconductors\njfet.ts:62-71, 169-186, 258-387` — state slots, clamp, updateOp, stamp
- `C:\local_working_projects\digital_in_browser\src\components\semiconductors\pjfet.ts:86-244` — polarity-specific overrides (all deletable per Diff 4.x)
- `C:\local_working_projects\digital_in_browser\src\solver\analog\fet-base.ts:102-148, 399-470` — shared FET schema and MOS1convTest (incorrectly inherited by JFET)
- `C:\local_working_projects\digital_in_browser\src\solver\analog\newton-raphson.ts:89-205` — `pnjlim`, `fetlim`, `limvds` — already available; JFET needs only to CALL `fetlim`
- `C:\local_working_projects\digital_in_browser\src\solver\analog\load-context.ts:17-85` — `InitMode` union already includes `initPred`, `initSmsig`, `initTran`, so no infrastructure gaps for those paths
- `C:\local_working_projects\digital_in_browser\src\components\semiconductors\bjt.ts:1466-1476` — reference pattern for initPred state1→state0 copy
- `C:\local_working_projects\digital_in_browser\src\components\semiconductors\diode.ts:464-472` — reference pattern for initPred copy in a simpler device
- `C:\local_working_projects\digital_in_browser\src\components\semiconductors\mosfet.ts:1227-1236` — reference pattern for MOSFET initPred (closest analog to JFET)
- `C:\local_working_projects\digital_in_browser\src\components\semiconductors\__tests__\jfet.test.ts:19-22` — test imports that must be updated after Diff 3.1 slot rename
- `C:\local_working_projects\digital_in_browser\ref\ngspice\src\spicelib\devices\jfet\jfetdefs.h` — ngspice slot layout canonical source

agentId: a3759c980d609c47a (use SendMessage with to: 'a3759c980d609c47a' to continue this agent)
<usage>total_tokens: 143980
tool_uses: 12
duration_ms: 446490</usage>