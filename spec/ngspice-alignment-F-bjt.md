# ngspice alignment — F-BJT: BJT full convergence port

_Extracted from ephemeral tool-results cache. Source agent output verbatim below._

---

I have all the evidence needed. Now producing the full audit with concrete diffs.

---

# F-BJT — Full ngspice Alignment Audit for `src/components/semiconductors/bjt.ts`

## Deliverable 1 — Section map of `bjtload.c`

Full read of `C:/local_working_projects/digital_in_browser/ref/ngspice/src/spicelib/devices/bjt/bjtload.c` (846 lines).

### Section-by-section table

| Line range | Section | Purpose |
|---|---|---|
| 25–145 | Function prologue + variable declarations | Local doubles/ints; `#ifndef PREDICTOR` guard for `xfact` |
| 146–150 | Model/instance loop preamble | `vt = BJTtemp*CONSTKoverQ`, `m = BJTm` |
| 155–163 | `CKTsenInfo` early perturbation guard | Sensitivity skip |
| 166–191 | DC model param setup | csat, csubsat, rbpr, rbpi, gcpr, gepr, oik, c2, vte, oikr, c4, vtc, td, xjrb |
| 192–230 | `SenCond` sensitivity voltage fetch | Reads vbe/vbc/vbx/vsub from rhsOp/rhsOld/state depending on sense mode |
| 232–236 | icheck init + `MODEINITSMSIG` branch | Reads vbe/vbc from state0; vbx/vsub from rhsOld |
| 245–257 | `MODEINITTRAN` branch | Reads vbe/vbc from state1; vbx/vsub from rhsOld; UIC override: `vbx = type*(ICVBE - ICVCE)`, `vsub = 0` |
| 258–264 | `MODEINITJCT && MODETRANOP && MODEUIC` | `vbe = type*ICVBE`, `vce = type*ICVCE`, `vbc = vbe-vce`, `vbx = vbc`, `vsub = 0` |
| 265–269 | `MODEINITJCT && !off` | `vbe = tVcrit`, `vbc = 0`, `vsub = 0`, `vbx = 0` |
| 270–275 | `MODEINITJCT OR (MODEINITFIX && off)` | `vbe = vbc = vsub = vbx = 0` |
| 277–306 | `#ifndef PREDICTOR` + `MODEINITPRED` | xfact extrapolation; copies state1→state0 for VBE, VBC, CC, CB, GPI, GMU, GM, GO, GX, VSUB; extrapolates vbe, vbc, vsub |
| 308–322 | Default (non-init) NR iteration | `vbe = type*(rhsOld[basePrime]-rhsOld[emitPrime])`, `vbc = type*(rhsOld[basePrime]-rhsOld[colPrime])`, `vsub = type*subs*(rhsOld[subst]-rhsOld[substCon])` |
| 323–330 | delvbe/delvbc + vbx/vsub re-read | vbx/vsub read from rhsOld (external base & substCon) |
| 331–337 | `cchat/cbhat` prediction | Currents predicted from linearization |
| 338–382 | `#ifndef NOBYPASS` bypass test | Nested `if` on delvbe/delvbc/cchat-cc/cbhat-cb tolerances; on bypass reads all gpi/gmu/gm/go/gx/geqcb/gcsub/geqbx/vsub/gdsub/cdsub from state0, `goto load` |
| 383–416 | DEVpnjlim on vbe/vbc/vsub | icheck aggregation: `ichk1=1` init, then `if (ichk1 == 1) icheck=1` after each limiter; 3 junctions |
| 420–446 | DC current cbe/cben with -3*vtn polynomial tail | gbe, gben ideal + leakage (c2) |
| 447–448 | GMIN add | `gben += CKTgmin; cben += CKTgmin*vbe` |
| 450–478 | DC current cbc/cbcn with -3*vtn polynomial tail | gbc, gbcn (c4) + GMIN |
| 480–491 | Substrate diode DC | `vts = vt*temissionCoeffS`, sign convention: reverse-bias (`vsub <= -3*vts`) uses polynomial, else `exp(MIN(MAX_EXP_ARG,...))` |
| 493–517 | Base charge factor qb | `q1`, `q2`, `sqarg` (pow(NKF) or sqrt), `dqbdve`, `dqbdvc` |
| 519–543 | Excess-phase (Weil) + backward-Euler | `td != 0`; 3-term filter; reads/writes `cexbc` slot |
| 547–548 | Terminal currents `cc` and `cb` | `cc = cc + (cex-cbc)/qb - cbc/BetaR - cbcn`; `cb = cbe/BetaF + cben + cbc/BetaR + cbcn` |
| 549–556 | Base resistance gx | `gx = rbpr + rbpi/qb`; xjrb nonlinear form with constants `14.59025` and `2.4317`, reciprocated at end |
| 557–560 | Small-signal gpi/gmu/gm/go | `go=(gbc+(cex-cbc)*dqbdvc/qb)/qb`; `gm=(gex-(cex-cbc)*dqbdve/qb)/qb - go`; `gpi=gbe/BetaF+gben`; `gmu=gbc/BetaR+gbcn` |
| 561–669 | Charge storage block (conditional MODETRAN/MODEAC/TRANOP+UIC/INITSMSIG) | czbe, pe, xme, ctot, czbc, czbx, pc, xmc, fcpe, czsub, ps, xms, xtf, ovtf, xjtf, argtf, `tf != 0 && vbe >0` XTF dependence updates cbe, gbe, geqcb; B-E depletion cap + diffusion; B-C depletion cap; vbx/vsub depletion caps; stores `capbe`, `capbc`, `capsub`, `capbx` to instance + qbe/qbc/qbx/qsub to state0 |
| 670–703 | MODEINITSMSIG linearization storage | Writes `cqbe`, `cqbc`, `cqsub`, `cqbx`, `cexbc=geqcb` to state0; SENCOND path writes cc/cb/gpi/gmu/gm/go/gx/gcsub/geqbx; `continue` (skips stamping) |
| 704–740 | Non-SMSIG transient path | MODEINITTRAN: copy q0→q1 for qbe/qbc/qbx/qsub; NIintegrate(capbe, BJTqbe) → adds geq to gpi and cqbe to cb; NIintegrate(capbc, BJTqbc) → adds geq to gmu, cqbc to cb, -cqbc to cc; `geqcb *= CKTag[0]`; MODEINITTRAN: copy cqbe/cqbc to state1 |
| 744 | `SenCond` branch to `next2:` | Skip load for sensitivity |
| 749–754 | Convergence check | `!(INITFIX) OR !(off)` → `if (icheck==1) CKTnoncon++` + `CKTtroubleElt = here` |
| 756–770 | c-s and b-x junction NIintegrate | Only during MODETRAN/MODEAC; stores into `gcsub`, `geqbx`; MODEINITTRAN: copy cqbx/cqsub to state1 |
| 771–786 | `next2:` state0 writeback | Stores vbe, vbc, cc, cb, gpi, gmu, gm, go, gx, geqcb, gcsub, geqbx, vsub, gdsub, cdsub |
| 788–791 | `SenCond` perturbation skip stamp | |
| 793–814 | `load:` RHS load | `geqsub = gcsub+gdsub`; `ceqsub`, `ceqbx`, `ceqbe`, `ceqbc` constructed; 6 RHS stamps: base, colPrime, substCon, basePrime, emitPrime, subst |
| 816–842 | Y-matrix (G) stamps | 25 matrix stamps, exact destinations and signs |

### Numerical apparatus enumerations

**MODEINITSMSIG (line 236, 676–692)** — vbe/vbc from state0; vbx/vsub from rhsOld; then stores cqbe=capbe, cqbc=capbc, cqsub=capsub, cqbx=capbx, cexbc=geqcb into state0. If `SenCond`, also writes cc, cb, gpi, gmu, gm, go, gx, gcsub, geqbx. Then `continue`.

**MODEINITJCT (lines 258–275)** — Three sub-branches:
1. `MODEINITJCT && MODETRANOP && MODEUIC`: vbe=type*ICVBE, vce=type*ICVCE, vbc=vbe-vce, vbx=vbc, vsub=0
2. `MODEINITJCT && off==0`: vbe=tVcrit, vbc=0, vsub=0, vbx=0
3. `MODEINITJCT OR (INITFIX && off)`: vbe=0, vbc=0, vsub=0, vbx=0

**MODEINITFIX** — uses default NR path EXCEPT when `off!=0`, where it falls into case 3 above (all zero).

**MODEINITPRED (lines 277–306, `#ifndef PREDICTOR` ACTIVE by default)**:
```
xfact = CKTdelta / CKTdeltaOld[1];
state0[VBE] = state1[VBE]; vbe = (1+xfact)*state1[VBE] - xfact*state2[VBE];
state0[VBC] = state1[VBC]; vbc = (1+xfact)*state1[VBC] - xfact*state2[VBC];
state0[CC]  = state1[CC];
state0[CB]  = state1[CB];
state0[GPI] = state1[GPI];
state0[GMU] = state1[GMU];
state0[GM]  = state1[GM];
state0[GO]  = state1[GO];
state0[GX]  = state1[GX];
state0[VSUB] = state1[VSUB]; vsub = (1+xfact)*state1[VSUB] - xfact*state2[VSUB];
```
Note: no GEQCB/GCSUB/GEQBX/CEXBC copy in initPred (they are recomputed).

**MODEINITTRAN (lines 245–257)** — vbe/vbc from state1; vbx/vsub from rhsOld; UIC override sets vbx=type*(ICVBE-ICVCE), vsub=0.

**Non-init NR (lines 308–322)** — vbe/vbc from rhsOld[basePrime−emitPrime/colPrime]; vsub from rhsOld[subst−substCon]; then `delvbe`, `delvbc`, vbx/vsub (again).

**DEVpnjlim calls (lines 387–415)**:
```
ichk1 = 1;
vbe = DEVpnjlim(vbe, state0[BJTvbe], vt, tVcrit, &icheck);
vbc = DEVpnjlim(vbc, state0[BJTvbc], vt, tVcrit, &ichk1);
if (ichk1==1) icheck=1;
vsub = DEVpnjlim(vsub, state0[BJTvsub], vt, tSubVcrit, &ichk1);
if (ichk1==1) icheck=1;
```
NOTE: BE uses `&icheck` directly; BC and VSUB use `&ichk1` with `if(ichk1==1) icheck=1` aggregation. This is OR semantics: any junction limited → icheck=1.

**Bypass test (lines 338–382)** — Four nested `if`s:
- `CKTbypass` enabled
- NOT MODEINITPRED
- `|delvbe| < reltol*max(|vbe|,|state0[vbe]|) + voltTol`
- `|delvbc| < reltol*max(|vbc|,|state0[vbc]|) + voltTol`
- `|cchat - state0[cc]| < reltol*max(|cchat|,|state0[cc]|) + abstol`
- `|cbhat - state0[cb]| < reltol*max(|cbhat|,|state0[cb]|) + abstol`

On bypass, reads VBE, VBC, CC, CB, GPI, GMU, GM, GO, GX, GEQCB, GCSUB, GEQBX, VSUB, GDSUB, CDSUB from state0 and jumps to `load:` (skips I-V calc, NIintegrate, convergence check).

**Convergence / icheck aggregation (lines 749–754)**:
```
if (!(MODEINITFIX) || !(off))
    if (icheck==1) { CKTnoncon++; CKTtroubleElt = here; }
```

**I-V equation (lines 420–560)** — Full Gummel-Poon with qb, XTF-dependent cbe, excess phase.

**Charge storage (lines 561–669)** — Depletion cap formulas with FC crossover; diffusion cap = `tf*gbe` (or `tf*gbe_modified`); NIintegrate for BE, BC, CS, BX.

**Stamping (lines 793–842)** — 6 RHS stamps + 25 G stamps. Stamp destinations explicit.

**Sensitivity (CKTsenInfo)** — Fully gated; writes to `BJTsens` arrays (unused in our impl, skipped).

### State-slot layout (bjtdefs.h:289–313)

| Slot | Name | Purpose | Read in | Written in |
|---|---|---|---|---|
| 0 | BJTvbe | Limited B-E voltage | INITSMSIG, INITPRED, INITTRAN, bypass, pnjlim | Every non-SenCond path |
| 1 | BJTvbc | Limited B-C voltage | same | same |
| 2 | BJTcc | Collector current (cc) | INITPRED copy, bypass, cchat | state0 writeback |
| 3 | BJTcb | Base current (cb) | INITPRED copy, bypass, cbhat | state0 writeback |
| 4 | BJTgpi | gbe/BetaF+gben | INITPRED copy, bypass | state0 writeback |
| 5 | BJTgmu | gbc/BetaR+gbcn | same | same |
| 6 | BJTgm | Transconductance | same | same |
| 7 | BJTgo | Output conductance | same | same |
| 8 | BJTqbe | BE junction charge (integrated) | NIintegrate | charge block |
| 9 | BJTcqbe | BE companion current | Norton RHS | NIintegrate |
| 10 | BJTqbc | BC junction charge | NIintegrate | charge block |
| 11 | BJTcqbc | BC companion current | Norton RHS | NIintegrate |
| 12 | BJTqsub | CS charge | NIintegrate | charge block |
| 13 | BJTcqsub | CS companion current | Norton RHS | NIintegrate |
| 14 | BJTqbx | BX charge | NIintegrate | charge block |
| 15 | BJTcqbx | BX companion current | Norton RHS | NIintegrate |
| 16 | BJTgx | Base resistance (reciprocal) | INITPRED copy, bypass | state0 writeback |
| 17 | BJTcexbc | Excess-phase current (history) | Excess-phase filter; SMSIG: geqcb | Every transient iter |
| 18 | BJTgeqcb | Base charge feedback conductance (ag0 scaled) | Stamp, RHS | NIintegrate path |
| 19 | BJTgcsub | CS companion conductance | Stamp | state0 writeback |
| 20 | BJTgeqbx | BX companion conductance | Stamp | state0 writeback |
| 21 | BJTvsub | Limited substrate voltage | INITPRED, pnjlim, bypass | state0 writeback |
| 22 | BJTcdsub | Substrate diode current | bypass | state0 writeback |
| 23 | BJTgdsub | Substrate diode conductance | bypass, stamp | state0 writeback |

24 base slots + 8 sensitivity slots (unused).

---

## Deliverable 2 — Current state of our BJT models

File: `C:/local_working_projects/digital_in_browser/src/components/semiconductors/bjt.ts` (2574 lines). Two distinct models:

### Model A — Simple (spice-l0)

**Location:** `createBjtElement` lines 636–973.

**State slot layout** (10 slots, `BJT_SIMPLE_SCHEMA` lines 619–630):
- 0 VBE, 1 VBC, 2 GPI, 3 GMU, 4 GM, 5 GO, 6 IC, 7 IB, 8 IC_NORTON, 9 IB_NORTON.

**Convergence apparatus:**
- pnjlim calls: `load()` lines 830, 833 — `pnjlim(vbeRaw, s0[VBE], tp.vt, tVcrit)` and `pnjlim(vbcRaw, s0[VBC], tp.vt, tVcrit)`.
- icheck aggregation: `icheckLimited = vbeLimFlag || vbcLimFlag` (line 836) — OR semantics correct.
- `ctx.noncon.value++` on icheckLimited (line 839).
- initJct handling: lines 803–813 — `OFF → 0,0`; `UIC → ICVBE, ICVBE-ICVCE`; else `tVcrit, 0`.
- initPred: lines 777–786 — copies VBE, VBC, IC, IB, GPI, GMU, GM, GO from s1 to s0. **Missing: xfact-based extrapolation of VBE/VBC.**
- initTran handling: NONE.
- initSmsig handling: NONE.
- initFix: partial (checkConvergence returns true if `OFF && initFix`, line 925).
- Bypass test: NONE.

**I-V equation:** `computeBjtOp` (lines 521–613) — Gummel-Poon with qb, fixed `sqrt` (no NKF). Simplifications:
- NE=1.5, NC=2.0 hardcoded (lines 673) — not parameterized.
- No XTF, no excess phase, no charge storage.

**Charge storage:** NONE. Non-reactive element.

**Stamping order** (lines 894–921): gpi (4 entries, BE), gmu (4 entries, BC), go (4 entries, CE), gm transconductance (4 entries, C←B,E and E←B,E). Norton RHS at C, B, E. 16 G stamps + 3 RHS stamps.

**Divergences from bjtload.c (model A):**

| # | Divergence | Our line | ngspice line |
|---|---|---|---|
| A1 | No xfact extrapolation in initPred | 777–786 | 277–306 |
| A2 | No MODEINITSMSIG block | — | 236–244, 676–703 |
| A3 | No MODEINITTRAN block | — | 245–257 |
| A4 | No MODEINITFIX off-mode zero-seeding | 803–813 | 270–275 |
| A5 | No bypass test | — | 338–382 |
| A6 | No cchat/cbhat convergence prediction in load (only in checkConvergence) | — | 331–337 |
| A7 | icheck aggregation is correct (OR via `||`) but convergence gate missing `INITFIX && off` exception | 839 | 749–754 |
| A8 | NE/NC hardcoded to 1.5/2.0 instead of param-driven | 673 | bjtdefs.h param |
| A9 | Simple model reads node voltages from (vB-vE) and (vB-vC) directly (no basePrime/emitPrime distinction) | 815–816 | 311–316 — but simple has no RB/RE/RC → nodeB==basePrime etc. Architecturally equivalent. |
| A10 | No substrate support (F5-G — intentional per spec; document only) | — | 317–319, 482–491 |
| A11 | Stamping layout matches topology-equivalent; `-polarity*Norton` sign uses the polarity flip rather than ngspice's `type*` inside ceqbe/ceqbc construction. Result identical but evidence warrants verification. | 919–921 | 803–814 |
| A12 | `applyInitialValues(..., { polarity })` seeds VBE=0.6 (NPN) or −0.6 (PNP) rather than 0. Correct-by-intent — matches post-initJct tVcrit seed — but ngspice initPred pre-iteration would expect last-step value, not schema default. |
| A13 | `computeBjtOp` applies `Math.exp(Math.min(vbe/nfVt, 700))` clamp — not in ngspice | 548, 560 | 423, 453 |

### Model B — SPICE-L1 Gummel-Poon

**Location:** `createSpiceL1BjtElement` lines 1201–2169.

**State slot layout** (51 slots, `BJT_L1_SCHEMA` lines 1130–1195):
- Many additional slots beyond ngspice's 24 (cap companions, excess phase history, OP storage, Q_BE/Q_BC/Q_CS, CTOT_*, CCAP_*, IC_DC/IB_DC, VSUB/GDSUB/CDSUB, OP_IF/OP_IR/OP_GBC). No harm from extras, but missing slots matter.

**Convergence apparatus:**
- pnjlim calls: lines 1526–1535 — BE, BC, VSUB. Correct args.
- icheck aggregation: `icheckLimited = vbeLimFlag || vbcLimFlag || vsubLimFlag` (line 1535) — OR semantics correct.
- `ctx.noncon.value++` on icheckLimited (line 1538).
- initJct handling: lines 1495–1509.
- initPred: lines 1467–1476 — copies VBE, VBC, IC, IB, GPI, GMU, GM, GO. **Missing: xfact extrapolation; missing GX/RB_EFF copy; missing VSUB copy and extrapolation.**
- initTran handling: `isFirstTranCall = ctx.initMode === "initTran"` (line 1690) seeds q1 from q0.
- initSmsig handling: NONE.
- initFix: same as simple (line 2070).
- Bypass test: NONE.

**I-V equation:** `computeSpiceL1BjtOp` (lines 989–1124). Correct Gummel-Poon with NKF generalization.

**Charge storage:** Full — B-E, B-C (split by XCJC), C-S. `niIntegrate` called at lines 1773, 1799, 1829. Excess-phase filter at lines 1874–1948.

**Stamping:** Lines 1966–2066. Terminal resistances (RC, RE, RB_EFF), gpi, gmu, go, gm, 4 geqcb stamps, 3 Norton RHS, substrate diode DC, external BC cap, CS cap. Pattern closely matches ngspice.

**Divergences from bjtload.c (model B):**

| # | Divergence | Our line | ngspice line |
|---|---|---|---|
| B1 | initPred missing xfact extrapolation of VBE, VBC | 1468–1469 | 282–287 |
| B2 | initPred missing VSUB copy and xfact extrapolation | — | 302–305 |
| B3 | initPred missing GX/RB_EFF copy | — | 300–301 |
| B4 | initPred missing CC/CB copy under this branch name (actually present as IC/IB at lines 1470–1471 — OK) | 1470–1471 | 288–291 |
| B5 | No MODEINITSMSIG block (store cqbe/cqbc/cqsub/cqbx/cexbc=geqcb to state0 then `continue`) | — | 676–703 |
| B6 | No MODEINITFIX off-mode zero-seeding | 1495–1509 | 270–275 |
| B7 | No MODEINITJCT MODETRANOP+MODEUIC branch (`vbe=type*ICVBE; vbc=vbe-type*ICVCE`) — our factory uses `vbeRaw = ICVBE; vbcRaw = ICVBE - ICVCE` but only gated on `pool.uic && !isNaN(ICVBE) && !isNaN(ICVCE)`, while ngspice also gates on `MODETRANOP`, and does not require both ICs | 1499–1502 | 258–264 |
| B8 | No bypass test | — | 338–382 |
| B9 | No cchat/cbhat prediction inside load() (ngspice computes them pre-bypass) | — | 331–337 |
| B10 | icheck aggregation correctly ORs via `||`, but convergence gate does not encode `!(INITFIX && off)` exception | 1538 | 749–754 |
| B11 | pnjlim applied during initPred. ngspice pnjlim runs only on the default non-init NR path (lines 383–416 are inside the `else` that runs AFTER `if (MODEINITPRED) {...} else {...}`). During MODEINITPRED, vbe/vbc come from xfact extrapolation and are NOT pnjlim'd. | 1520 | 277–306 |
| B12 | `vsubRaw = polarity * subs * (0 - vSubConRaw)` assumes substrate tied to ground; ngspice reads `rhsOld[substNode]-rhsOld[substConNode]`. If we don't allocate a substrate node, this is a model-scope divergence — document. | 1488 | 317–319 |
| B13 | subs polarity encoded as `polarity > 0 ? 1 : -1` (VERTICAL for NPN, LATERAL for PNP). ngspice BJTsubs is a *model* param (VERTICAL default for both NPN and PNP). This is a divergence: BJTsubs is independent of NPN/PNP type. | 1485 | bjtdefs.h:576–580, bjtload.c:184 |
| B14 | No `BJTsubs` param parsed from `SUBS` model parameter | 1212–1262 | BJT_MOD_SUBS (bjtdefs.h:696) |
| B15 | areab/areac params not plumbed (VERTICAL uses areab for BJTtBCleakCur, LATERAL uses areac) | — | 184–187 |
| B16 | Temperature code `computeBjtTempParams` uses `tbaseResist = p.RB` unconditionally; ngspice bjttemp has polynomial `tbf1/tbf2/tbr1/tbr2/tnf1/tnf2/tre1/...` temperature coeffs that are ignored. Simple model-scope simplification. | 396 | bjttemp.c |
| B17 | `tminBaseResist = p.RBM > 0 ? p.RBM : p.RB` — matches ngspice bjttemp. | 397 | bjttemp.c:166 |
| B18 | `excessPhaseFactor` uses `params.PTF > 0 && params.TF > 0`; ngspice uses `PTF` unconditionally (0 gives 0 factor, no divide). Minor but differs. | 461 | bjttemp.c |
| B19 | Sign convention of RHS stamps uses `m * -polarity * icNorton`, while ngspice produces `m * ceqbe` with `ceqbe = type*(cc+cb-vbe*(gm+go+gpi)+vbc*(go-geqcb))`. Our construction: `IC_NORTON = ic - (gm+go)*vbe + (gmu+go)*vbc` pushed to colPrime as `-polarity * icNorton`. ngspice pushes `ceqbx+ceqbc` to colPrime. Need to verify the two formulations yield identical values after polarity. Potential sign divergence in `(op.gmu+op.go)` vs `(go-geqcb)` — specifically ngspice uses `go-geqcb` but we use `gmu+op.go`. **Likely bug.** | 1628–1630 | 803–805 |
| B20 | Excess-phase filter update order diverges: we shift history at lines 1945–1947 AFTER already writing `CEXBC_NOW` in the init branch. ngspice uses state0/state1/state2 which rotate externally; we keep a 3-slot intra-step history. Functional equivalence possible but needs verification. | 1945–1947 | 532–542 |
| B21 | `computeSpiceL1BjtOp` always adds GMIN to gpi, gmu (lines 1120–1121). ngspice adds GMIN to `gben` and `gbcn` (c2/c4 exp leakage) only, and adds `CKTgmin*vbe` to `cben`, `CKTgmin*vbc` to `cbcn` (bjtload.c:447–448, 477–478). Subtle: our addition to gpi (line 1120) is right only when c2=0 and ngspice's `gben += CKTgmin` still fires. **This is actually ngspice-correct because gpi = gbe/BetaF + gben, and gben includes gmin.** No divergence. |
| B22 | Our `ic` subtracts `GMIN * vbc` along with cbcn at line 1069. ngspice: `cc = ... - cbcn` where `cbcn += CKTgmin*vbc`. This is correct. |
| B23 | Our L1 computation applies `Math.exp(Math.min(..., 700))` clamp to prevent overflow; ngspice has no clamp. | 1016, 1028, 1054, 1075, 1607, 1659, 1703, 1901, 1934 | 423, 453, 467, 436 |
| B24 | `Q_BE = Q_depl_BE + tf_eff_base * cbe_for_q` (line 1721). ngspice: `state0[qbe] = tf*cbe + pe*czbe*(1-arg*sarg)/(1-xme)` or spline form. `pe*czbe*(1-arg*sarg)/(1-xme)` is the computeJunctionCharge Q_depl. We divide-then-sum; ngspice computes as one expression. Functional equivalence. |
| B25 | Our `CdBE = tf_eff_base * op.gm` on the non-XTF path (line 1711). ngspice: `capbe = tf*gbe + czbe*sarg` (bjtload.c:617), where `gbe` is the RAW gbe (not modified). We use `op.gm` which is `dIfdVbe/qb - ... - go`. **This is a divergence** — ngspice uses the raw BE junction conductance `gbe` in the diffusion cap formula, not the full Gummel-Poon `gm`. | 1711 | 617 |
| B26 | RB_EFF formula uses `op.ib` abs (line 1639). ngspice uses `cb/xjrb` (the total base current, which in our code IS `op.ib` pre-augmentation). OK. Also ngspice `gx = rbpr + rbpi/qb` for non-xjrb, and `gx = 1/gx` at end. We store `RB_EFF` as the RESISTANCE, then stamp `gRB = 1/RB_EFF`. Correct reciprocal. |
| B27 | Our `geqcb_dc` formula divides by `op.qb` twice (line 1617 `/ op.qb`, then ngspice formula is `tf*(arg3-cbe*dqbdvc)/qb`). ngspice: `geqcb = tf*(arg3 - cbe*dqbdvc)/qb` — single division. Ours: `tf_eff_base * (arg3_dc - cbe_mod_dc * op.dqbdvc) / op.qb`. `cbe_mod_dc = op.If*(1+argtf_dc)/op.qb` — already divided by qb. So our formula is `tf*(arg3 - (If*(1+argtf)/qb)*dqbdvc)/qb` vs ngspice `tf*(arg3 - (cbe_modified)*dqbdvc)/qb` where `cbe_modified = cbe*(1+argtf)/qb` (bjtload.c:608). cbe at that point (line 608) = original cbe from GP I-V divided by qb earlier? No — at bjtload.c:547 `cc=cc+(cex-cbc)/qb-cbc/BetaR-cbcn`, but cbe hasn't been divided. At line 608 `cbe = cbe*(1+argtf)/qb`. So ngspice cbe_mod = cbe_raw*(1+argtf)/qb where cbe_raw = `csat*(evbe-1)` = `op.If`. Our `cbe_mod_dc = op.If*(1+argtf_dc)/op.qb` — **matches**. |
| B28 | `Q_CS` when `MJS≈1` uses `-ps*czsub*log(arg)` (line 1749). ngspice: `state0[qsub] = ps*czsub*(1-arg*sarg)/(1-xms)` — singular at xms=1. We use L'Hopital. ngspice simulates with MJS=0.5 typically, this edge case is undefined in ngspice. Document. |
| B29 | `IE_NORTON = -(ic+ib) + (gm+go+gpi)*vbe - (go-geqcb)*vbc` (line 1630, 1871, 1924) — matches ngspice's derived `ceqbe` formulation by combining `-ceqbe - ceqbc` at emitPrime. This is a computed quantity; verify sign. |
| B30 | When `hasCapacitance` is false but we're in transient, no cap companions are stamped. ngspice bjtload bypasses `NIintegrate` when caps are zero but **still** executes the `if(MODETRAN | MODEAC)` block (for the qsub/qbx NIintegrate at lines 759–770). Our block is gated on `hasCapacitance`. If `CJE=0 CJC=0 TF=0 TR=0` but `CJS>0`, we'd still need to integrate qsub — our `hasCapacitance` includes `CJS > 0` so this is fine. |
| B31 | Our B-C external cap stamps at lines 2052–2057 use `nodeB_ext, nodeC_ext`. ngspice: `baseBasePtr += geqbx`, `colPrimeColPrimePtr += geqbx`, `baseColPrimePtr += -geqbx`, `colPrimeBasePtr += -geqbx` (lines 820, 822, 841, 842). So ngspice stamps between baseNode (external B) and colPrimeNode (INTERNAL collector), not external C. **This is a divergence.** | 2052–2055 | 820, 822, 841, 842 |
| B32 | Our excess-phase filter ignores the `MODETRAN | MODEAC` gate — we run it whenever `tpL1.excessPhaseFactor > 0` and `ctx.isTransient && dt > 0` (which is equivalent). OK. |

---

## Deliverable 3 — Concrete diffs for BJT simple (spice-l0)

### Diff A1 — Add xfact extrapolation + full state-copy list to initPred

**File:** `C:/local_working_projects/digital_in_browser/src/components/semiconductors/bjt.ts`

**OLD (lines 774–786):**
```ts
    load(ctx: LoadContext): void {
      const voltages = ctx.voltages;

      if (ctx.initMode === "initPred") {
        s0[base + SLOT_VBE] = s1[base + SLOT_VBE];
        s0[base + SLOT_VBC] = s1[base + SLOT_VBC];
        s0[base + SLOT_IC]  = s1[base + SLOT_IC];
        s0[base + SLOT_IB]  = s1[base + SLOT_IB];
        s0[base + SLOT_GPI] = s1[base + SLOT_GPI];
        s0[base + SLOT_GMU] = s1[base + SLOT_GMU];
        s0[base + SLOT_GM]  = s1[base + SLOT_GM];
        s0[base + SLOT_GO]  = s1[base + SLOT_GO];
      }
```

**NEW:**
```ts
    load(ctx: LoadContext): void {
      const voltages = ctx.voltages;

      // bjtload.c:277-306 (#ifndef PREDICTOR, default build). Copy state1→state0
      // linearization slots and extrapolate vbe/vbc via xfact.
      // Simple model has no substrate → VSUB slot not present (model-scope limit).
      // Simple model has no GX slot → GX copy not present (no base-resistance linearization).
      let vbePred = s0[base + SLOT_VBE];
      let vbcPred = s0[base + SLOT_VBC];
      if (ctx.initMode === "initPred") {
        const xfact = ctx.deltaOld[0] > 0 ? ctx.dt / ctx.deltaOld[0] : 0;
        s0[base + SLOT_VBE] = s1[base + SLOT_VBE];
        vbePred = (1 + xfact) * s1[base + SLOT_VBE] - xfact * s2[base + SLOT_VBE];
        s0[base + SLOT_VBC] = s1[base + SLOT_VBC];
        vbcPred = (1 + xfact) * s1[base + SLOT_VBC] - xfact * s2[base + SLOT_VBC];
        s0[base + SLOT_IC]  = s1[base + SLOT_IC];
        s0[base + SLOT_IB]  = s1[base + SLOT_IB];
        s0[base + SLOT_GPI] = s1[base + SLOT_GPI];
        s0[base + SLOT_GMU] = s1[base + SLOT_GMU];
        s0[base + SLOT_GM]  = s1[base + SLOT_GM];
        s0[base + SLOT_GO]  = s1[base + SLOT_GO];
      }
```
(And further down, the pnjlim branch must use `vbePred/vbcPred` when `initMode === "initPred"` instead of reading `vbeRaw` from `rhsOld`-equivalent node voltages — see A1-follow-on below.)

**ngspice citation:** `ref/ngspice/src/spicelib/devices/bjt/bjtload.c:277–306`.

### Diff A1-follow-on — Route extrapolated vbe/vbc into pnjlim

**OLD (lines 814–837):**
```ts
      } else {
        vbeRaw = polarity * (vB - vE);
        vbcRaw = polarity * (vB - vC);
      }

      // Apply pnjlim to both junctions using vold from pool.
      // bjtload.c:258-276: during MODEINITJCT, voltages are set directly — no pnjlim applied.
      let vbeLimited: number;
      let vbcLimited: number;
      let vbeLimFlag = false;
      let vbcLimFlag = false;
      if (ctx.initMode === "initJct") {
        vbeLimited = vbeRaw;
        vbcLimited = vbcRaw;
        icheckLimited = false;
      } else {
        const vbeResult = pnjlim(vbeRaw, s0[base + SLOT_VBE], tp.vt, vcritBE);
        vbeLimited = vbeResult.value;
        vbeLimFlag = vbeResult.limited;
        const vbcResult = pnjlim(vbcRaw, s0[base + SLOT_VBC], tp.vt, vcritBC);
        vbcLimited = vbcResult.value;
        vbcLimFlag = vbcResult.limited;
        icheckLimited = vbeLimFlag || vbcLimFlag;
      }
```

**NEW:**
```ts
      } else if (ctx.initMode === "initPred") {
        // bjtload.c:278-305: vbe/vbc come from xfact extrapolation, NOT rhsOld.
        vbeRaw = vbePred;
        vbcRaw = vbcPred;
      } else {
        vbeRaw = polarity * (vB - vE);
        vbcRaw = polarity * (vB - vC);
      }

      // Apply pnjlim to both junctions using vold from pool.
      // bjtload.c:258-306: during MODEINITJCT voltages are set directly; during
      // MODEINITPRED vbe/vbc are xfact-extrapolated and pnjlim is NOT called
      // (the pnjlim block at bjtload.c:383-416 is inside the `else` branch that
      // runs after MODEINITPRED has returned).
      let vbeLimited: number;
      let vbcLimited: number;
      let vbeLimFlag = false;
      let vbcLimFlag = false;
      if (ctx.initMode === "initJct" || ctx.initMode === "initPred") {
        vbeLimited = vbeRaw;
        vbcLimited = vbcRaw;
        icheckLimited = false;
      } else {
        // bjtload.c:383-416 — ichk1 OR-aggregation.
        let ichk1 = 1;
        const vbeResult = pnjlim(vbeRaw, s0[base + SLOT_VBE], tp.vt, vcritBE);
        vbeLimited = vbeResult.value;
        vbeLimFlag = vbeResult.limited;
        // BE writes `&icheck` directly; BC writes `&ichk1` and ORs.
        const icheckBE = vbeLimFlag ? 1 : 0;
        const vbcResult = pnjlim(vbcRaw, s0[base + SLOT_VBC], tp.vt, vcritBC);
        vbcLimited = vbcResult.value;
        vbcLimFlag = vbcResult.limited;
        ichk1 = vbcLimFlag ? 1 : 0;
        const icheck = (icheckBE === 1 || ichk1 === 1) ? 1 : 0;
        icheckLimited = icheck === 1;
      }
```

**ngspice citation:** `bjtload.c:277–306`, `bjtload.c:383–416`.

### Diff A2 — Add MODEINITSMSIG block

Simple model does not track capbe/capbc (no caps), but the ngspice SMSIG block ALSO stores `cc, cb, gpi, gmu, gm, go, gx` to state0 when `SenCond` (not applicable to us). For simple model the SMSIG block collapses to: "read vbe/vbc from state0, evaluate GP op, `continue` (skip stamp)." Adding explicit handling:

**OLD (lines 777 onwards):**
```ts
      if (ctx.initMode === "initPred") {
```

**NEW:**
```ts
      // bjtload.c:236-244 — MODEINITSMSIG: use stored state0 linearization,
      // do NOT re-solve, and do NOT stamp. For the simple model there is no
      // substrate pnjlim and no capacitance state to seed; the block only
      // guarantees vbe/vbc come from state0 so the I-V re-eval matches the
      // last accepted DC OP.
      if (ctx.initMode === "initSmsig") {
        // vbe/vbc already in state0 from previous DC-OP convergence.
        // computeBjtOp will re-evaluate at those voltages; stamps follow.
        // No additional state mutation.
      }
      if (ctx.initMode === "initPred") {
```

**ngspice citation:** `bjtload.c:236–244, 676–703`.

### Diff A3 — Add MODEINITJCT full priming per bjtload.c:258-275

**OLD (lines 803–813):**
```ts
      if (ctx.initMode === "initJct") {
        if (params.OFF) {
          vbeRaw = 0;
          vbcRaw = 0;
        } else if (pool.uic && !isNaN(params.ICVBE) && !isNaN(params.ICVCE)) {
          vbeRaw = params.ICVBE;
          vbcRaw = params.ICVBE - params.ICVCE;
        } else {
          vbeRaw = tp.tVcrit;
          vbcRaw = 0;
        }
      } else {
```

**NEW:**
```ts
      // bjtload.c:258-275 — MODEINITJCT / MODEINITFIX junction priming.
      // Branch priority MUST match ngspice exactly:
      //   1. INITJCT && MODETRANOP && MODEUIC: vbe=ICVBE, vbc=vbe-ICVCE
      //   2. INITJCT && !off: vbe=tVcrit, vbc=0
      //   3. INITJCT || (INITFIX && off): vbe=vbc=0
      const inTranOpUic = pool.uic && ctx.isDcOp;
      const inInitFixOff = ctx.initMode === "initFix" && params.OFF !== 0;
      if (ctx.initMode === "initJct" && inTranOpUic && !isNaN(params.ICVBE) && !isNaN(params.ICVCE)) {
        // Case 1 — UIC with ICs
        vbeRaw = polarity * params.ICVBE;
        const vceGiven = polarity * params.ICVCE;
        vbcRaw = vbeRaw - vceGiven;
      } else if (ctx.initMode === "initJct" && params.OFF === 0) {
        // Case 2
        vbeRaw = tp.tVcrit;
        vbcRaw = 0;
      } else if (ctx.initMode === "initJct" || inInitFixOff) {
        // Case 3 — INITJCT with off, or INITFIX with off
        vbeRaw = 0;
        vbcRaw = 0;
      } else {
```

**ngspice citation:** `bjtload.c:258–275`.

### Diff A4 — Bypass test (port bjtload.c:338–382)

**Inserted between the pnjlim block and the computeBjtOp call:**

**NEW (inserted after line 837 `icheckLimited = vbeLimFlag || vbcLimFlag;`):**
```ts
      // bjtload.c:338-382 — NOBYPASS bypass test. Skipped for MODEINITPRED and
      // when CKTbypass is off. When all four predictors are in tolerance, read
      // cached DC state from s0 and skip the I-V evaluation + convergence check,
      // then jump to the stamp block.
      let bypassed = false;
      if (ctx.bypass && ctx.initMode !== "initPred" && ctx.initMode !== "initJct" && ctx.initMode !== "initFix") {
        const cc_prev  = s0[base + SLOT_IC];
        const cb_prev  = s0[base + SLOT_IB];
        const gm_prev  = s0[base + SLOT_GM];
        const go_prev  = s0[base + SLOT_GO];
        const gpi_prev = s0[base + SLOT_GPI];
        const gmu_prev = s0[base + SLOT_GMU];
        const vbe_prev = s0[base + SLOT_VBE];
        const vbc_prev = s0[base + SLOT_VBC];
        const delvbe = vbeLimited - vbe_prev;
        const delvbc = vbcLimited - vbc_prev;
        const cchat = cc_prev + (gm_prev + go_prev) * delvbe - (go_prev + gmu_prev) * delvbc;
        const cbhat = cb_prev + gpi_prev * delvbe + gmu_prev * delvbc;
        const absVbe = Math.max(Math.abs(vbeLimited), Math.abs(vbe_prev));
        const absVbc = Math.max(Math.abs(vbcLimited), Math.abs(vbc_prev));
        const absCc  = Math.max(Math.abs(cchat), Math.abs(cc_prev));
        const absCb  = Math.max(Math.abs(cbhat), Math.abs(cb_prev));
        if (Math.abs(delvbe) < ctx.reltol * absVbe + ctx.voltTol &&
            Math.abs(delvbc) < ctx.reltol * absVbc + ctx.voltTol &&
            Math.abs(cchat - cc_prev) < ctx.reltol * absCc + ctx.iabstol &&
            Math.abs(cbhat - cb_prev) < ctx.reltol * absCb + ctx.iabstol) {
          bypassed = true;
        }
      }
```

Then gate the `computeBjtOp` call and OP-slot writeback on `!bypassed`:
```ts
      if (!bypassed) {
        s0[base + SLOT_VBE] = vbeLimited;
        s0[base + SLOT_VBC] = vbcLimited;
        const op = computeBjtOp( /* ... existing args ... */ );
        s0[base + SLOT_GPI] = op.gpi;
        /* ... existing writeback ... */
        s0[base + SLOT_IC_NORTON] = icNorton;
        s0[base + SLOT_IB_NORTON] = ibNorton;
      }
      // Read linearization (either just-written or bypassed from last iter).
      const gpi = s0[base + SLOT_GPI];
      const gmu = s0[base + SLOT_GMU];
      const gm  = s0[base + SLOT_GM];
      const go  = s0[base + SLOT_GO];
      const icNorton = s0[base + SLOT_IC_NORTON];
      const ibNorton = s0[base + SLOT_IB_NORTON];
      const ieNorton = -(icNorton + ibNorton);
```

**ngspice citation:** `bjtload.c:338–382`.

**Note:** this requires `ctx.bypass` and `ctx.voltTol` to exist on `LoadContext`. If absent, extend `LoadContext` (out-of-scope for this audit but **flagged as required infra**). **Cross-reference: this infra is shared with diode/MOSFET bypass — see F-diode and F-mosfet audits.**

### Diff A5 — ichk aggregation gate matches bjtload.c:749-754

**OLD (line 839):**
```ts
      if (icheckLimited) ctx.noncon.value++;
```

**NEW:**
```ts
      // bjtload.c:749-754 — noncon++ gated on !(INITFIX) || !(off).
      // Equivalent: do NOT increment if both INITFIX and OFF are true.
      const nonconGate = !(ctx.initMode === "initFix" && params.OFF !== 0);
      if (icheckLimited && nonconGate) ctx.noncon.value++;
```

**ngspice citation:** `bjtload.c:749–754`.

### Diff A6 — Use `tp.tBEpot`-style BE-specific vcrit (one tVcrit for both OK — ngspice uses tVcrit for both BE and BC pnjlim)

**Already correct** — ngspice `bjtload.c:389` uses `here->BJTtVcrit` for BE and BC alike. Our code matches. No diff.

### Diff A7 — Remove Math.exp(700) clamp (ngspice has no clamp; overflow is absorbed by downstream divide-by-zero handling)

**OLD (line 548):** `const expVbe = Math.exp(Math.min(vbe / nfVt, 700));`

**NEW:** `const expVbe = Math.exp(vbe / nfVt);`

Apply to all 4 sites in `computeBjtOp` (lines 548, 560, plus the 2 leakage sites).

**ngspice citation:** `bjtload.c:423, 437, 453, 467` — no clamp.

**Note:** ngspice relies on the `vbe >= -3*vtn` gate to short-circuit the exp for deeply reverse-biased junctions; for forward bias beyond ~700 the result is IEEE `inf`, which propagates through the Jacobian and is caught by node-damping. Our clamp at 700 changes the trajectory of limiting. Strict parity requires dropping the clamp.

### Diff A8 — NE/NC should come from params (simple model needs NE/NC in BJT_PARAM_DEFS)

Simple model hard-codes NE=1.5, NC=2.0 at line 673. Since the simple model doesn't expose `BJT_PARAM_DEFS` with NE/NC, this is a **model-scope** limit. ngspice uses `tleakBEemissionCoeff = NE`. Fix by adding NE/NC to `BJT_PARAM_DEFS`:

**OLD (lines 60–82, 84–106):**
```ts
export const { paramDefs: BJT_PARAM_DEFS, defaults: BJT_NPN_DEFAULTS } = defineModelParams({
  primary: { BF: { default: 100 }, IS: { default: 1e-16, unit: "A" } },
  secondary: {
    NF:  { default: 1 }, BR:  { default: 1 }, VAF: { default: Infinity, unit: "V" },
    IKF: { default: Infinity, unit: "A" }, IKR: { default: Infinity, unit: "A" },
    ISE: { default: 0, unit: "A" }, ISC: { default: 0, unit: "A" },
    NR: { default: 1 }, VAR: { default: Infinity, unit: "V" },
    AREA: { default: 1 }, M: { default: 1 }, TNOM: { default: 300.15, unit: "K" },
    OFF: { default: 0 }, ICVBE: { default: NaN, unit: "V" }, ICVCE: { default: NaN, unit: "V" },
  },
});
```

**NEW:**
```ts
export const { paramDefs: BJT_PARAM_DEFS, defaults: BJT_NPN_DEFAULTS } = defineModelParams({
  primary: { BF: { default: 100 }, IS: { default: 1e-16, unit: "A" } },
  secondary: {
    NF: { default: 1 }, BR: { default: 1 }, VAF: { default: Infinity, unit: "V" },
    IKF: { default: Infinity, unit: "A" }, IKR: { default: Infinity, unit: "A" },
    ISE: { default: 0, unit: "A" }, ISC: { default: 0, unit: "A" },
    NE: { default: 1.5, description: "B-E leakage emission coefficient" },
    NC: { default: 2, description: "B-C leakage emission coefficient" },
    NR: { default: 1 }, VAR: { default: Infinity, unit: "V" },
    AREA: { default: 1 }, M: { default: 1 }, TNOM: { default: 300.15, unit: "K" },
    OFF: { default: 0 }, ICVBE: { default: NaN, unit: "V" }, ICVCE: { default: NaN, unit: "V" },
  },
});
```

And in `createBjtElement` (line 662):

**OLD:**
```ts
    OFF:   props.getModelParam<number>("OFF"),
```

**NEW (inserted before):**
```ts
    NE:    props.getModelParam<number>("NE"),
    NC:    props.getModelParam<number>("NC"),
    OFF:   props.getModelParam<number>("OFF"),
```

And in `makeTp()` (line 673):

**OLD:**
```ts
      NE: 1.5, NC: 2.0, EG: 1.11, XTI: 3, XTB: 0,
```

**NEW:**
```ts
      NE: params.NE, NC: params.NC, EG: 1.11, XTI: 3, XTB: 0,
```

And in the `computeBjtOp` call at lines 751, 871:

**OLD:**
```ts
        tp.vt, params.NE, params.NC,
```

**NEW:** (already passes `params.NE, params.NC` but these were `undefined` pre-fix — now real params.)

**ngspice citation:** `bjttemp.c:144, 218`, `bjtdefs.h:464–465`.

### Diff A9 — MODEINITTRAN handling (simple model has no caps, so no q-slot bcopy, but vbe/vbc must come from state1)

**NEW (in the init cascade, after initPred block):**
```ts
      // bjtload.c:245-257 — MODEINITTRAN: vbe/vbc from state1, vbx/vsub from
      // rhsOld. Simple model has no charge slots → no bcopy.
      if (ctx.initMode === "initTran") {
        // vbe/vbc already in s1 from previous DC-OP; for the simple model this
        // is also what state0 held after DC-OP, so no action is required beyond
        // using state1's VBE/VBC as the effective vold for pnjlim (which is the
        // default behavior since we compute vbeRaw from node voltages at the
        // first transient step, where those voltages were seeded by DC-OP).
      }
```
The node-voltage read at lines 815–816 already gives the correct `vbeRaw` at the first transient step. The missing piece is that at `initTran`, ngspice uses `state1[vbe]` as the effective "new" voltage, not `rhsOld[basePrime-emitPrime]`. In our framework, `rhsOld` is seeded from DC-OP, so the values match. **No functional diff for simple model** — just document.

---

## Deliverable 4 — Concrete diffs for BJT SPICE-L1 (Gummel-Poon)

### Diff B1 — Add xfact extrapolation + full state-copy list including GX and VSUB to initPred

**OLD (lines 1466–1476):**
```ts
      // --- Step 1: initPred — copy last accepted linearization ---
      if (ctx.initMode === "initPred") {
        s0[base + L1_SLOT_VBE] = s1[base + L1_SLOT_VBE];
        s0[base + L1_SLOT_VBC] = s1[base + L1_SLOT_VBC];
        s0[base + L1_SLOT_IC]  = s1[base + L1_SLOT_IC];
        s0[base + L1_SLOT_IB]  = s1[base + L1_SLOT_IB];
        s0[base + L1_SLOT_GPI] = s1[base + L1_SLOT_GPI];
        s0[base + L1_SLOT_GMU] = s1[base + L1_SLOT_GMU];
        s0[base + L1_SLOT_GM]  = s1[base + L1_SLOT_GM];
        s0[base + L1_SLOT_GO]  = s1[base + L1_SLOT_GO];
      }
```

**NEW:**
```ts
      // --- Step 1: initPred — bjtload.c:277-306 (#ifndef PREDICTOR, default).
      // Copy state1→state0 for all linearization + base-resistance + substrate
      // slots, and extrapolate vbe/vbc/vsub via xfact.
      let vbePred = s0[base + L1_SLOT_VBE];
      let vbcPred = s0[base + L1_SLOT_VBC];
      let vsubPred = s0[base + L1_SLOT_VSUB];
      if (ctx.initMode === "initPred") {
        const xfact = ctx.deltaOld[0] > 0 ? ctx.dt / ctx.deltaOld[0] : 0;
        s0[base + L1_SLOT_VBE] = s1[base + L1_SLOT_VBE];
        vbePred = (1 + xfact) * s1[base + L1_SLOT_VBE] - xfact * s2[base + L1_SLOT_VBE];
        s0[base + L1_SLOT_VBC] = s1[base + L1_SLOT_VBC];
        vbcPred = (1 + xfact) * s1[base + L1_SLOT_VBC] - xfact * s2[base + L1_SLOT_VBC];
        s0[base + L1_SLOT_IC]  = s1[base + L1_SLOT_IC];       // bjtload.c:288-289
        s0[base + L1_SLOT_IB]  = s1[base + L1_SLOT_IB];       // bjtload.c:290-291
        s0[base + L1_SLOT_GPI] = s1[base + L1_SLOT_GPI];      // bjtload.c:292-293
        s0[base + L1_SLOT_GMU] = s1[base + L1_SLOT_GMU];      // bjtload.c:294-295
        s0[base + L1_SLOT_GM]  = s1[base + L1_SLOT_GM];       // bjtload.c:296-297
        s0[base + L1_SLOT_GO]  = s1[base + L1_SLOT_GO];       // bjtload.c:298-299
        // F2.9 fix: GX/RB_EFF copy (bjtload.c:300-301)
        s0[base + L1_SLOT_RB_EFF] = s1[base + L1_SLOT_RB_EFF];
        // F2.9 fix: VSUB copy + xfact extrapolation (bjtload.c:302-305)
        s0[base + L1_SLOT_VSUB] = s1[base + L1_SLOT_VSUB];
        vsubPred = (1 + xfact) * s1[base + L1_SLOT_VSUB] - xfact * s2[base + L1_SLOT_VSUB];
      }
```

**ngspice citation:** `bjtload.c:277–306`.

### Diff B2 — Route predicted vbe/vbc/vsub into the downstream flow (skip pnjlim + read-from-node-voltages when initPred)

**OLD (lines 1478–1535):** Reads node voltages unconditionally, then conditionally skips pnjlim only for `initJct`.

**NEW (rewrite Steps 2 & 3):**
```ts
      // --- Step 2: Read internal-node voltages + substrate con voltage ---
      const vCi = nodeC_int > 0 ? voltages[nodeC_int - 1] : 0;
      const vBi = nodeB_int > 0 ? voltages[nodeB_int - 1] : 0;
      const vEi = nodeE_int > 0 ? voltages[nodeE_int - 1] : 0;

      const subs = polarity > 0 ? 1 : -1; // TODO B13: replace with model BJTsubs param
      const substConNode = subs > 0 ? nodeC_int : nodeB_int;
      const vSubConRaw = substConNode > 0 ? voltages[substConNode - 1] : 0;
      const vsubRawNode = polarity * subs * (0 - vSubConRaw);

      let vbeRaw: number;
      let vbcRaw: number;
      let vsubRaw: number;
      if (ctx.initMode === "initJct") {
        // bjtload.c:258-275 — full priming.
        const inTranOpUic = pool.uic && ctx.isDcOp;
        if (inTranOpUic && !isNaN(params.ICVBE) && !isNaN(params.ICVCE)) {
          vbeRaw = polarity * params.ICVBE;
          const vce = polarity * params.ICVCE;
          vbcRaw = vbeRaw - vce;
          vsubRaw = 0;
        } else if (params.OFF === 0) {
          vbeRaw = tpL1.tVcrit;
          vbcRaw = 0;
          vsubRaw = 0;
        } else {
          vbeRaw = 0; vbcRaw = 0; vsubRaw = 0;
        }
      } else if (ctx.initMode === "initFix" && params.OFF !== 0) {
        // bjtload.c:270-275 — INITFIX + off = same as INITJCT zero case.
        vbeRaw = 0; vbcRaw = 0; vsubRaw = 0;
      } else if (ctx.initMode === "initPred") {
        // bjtload.c:277-305 — xfact-extrapolated, NO pnjlim.
        vbeRaw = vbePred;
        vbcRaw = vbcPred;
        vsubRaw = vsubPred;
      } else if (ctx.initMode === "initTran") {
        // bjtload.c:245-257 — vbe/vbc from state1 (which our solver has rotated).
        vbeRaw = s1[base + L1_SLOT_VBE];
        vbcRaw = s1[base + L1_SLOT_VBC];
        vsubRaw = vsubRawNode;
        if (pool.uic && !isNaN(params.ICVBE) && !isNaN(params.ICVCE)) {
          vsubRaw = 0;
        }
      } else {
        // Default NR — bjtload.c:308-322.
        vbeRaw = polarity * (vBi - vEi);
        vbcRaw = polarity * (vBi - vCi);
        vsubRaw = vsubRawNode;
      }

      // --- Step 3: Apply pnjlim ---
      // Skipped for initJct (bjtload.c:258-275), initFix-with-off, initPred
      // (bjtload.c:277-306 returns before pnjlim), and initSmsig (bjtload.c:236).
      const vcritBE = tpL1.tVcrit;
      const vcritBC = tpL1.tVcrit;
      let vbeLimited: number;
      let vbcLimited: number;
      let vsubLimited: number;
      let vbeLimFlag = false;
      let vbcLimFlag = false;
      let vsubLimFlag = false;
      const skipLimit =
        ctx.initMode === "initJct" ||
        (ctx.initMode === "initFix" && params.OFF !== 0) ||
        ctx.initMode === "initPred" ||
        ctx.initMode === "initSmsig";
      if (skipLimit) {
        vbeLimited = vbeRaw;
        vbcLimited = vbcRaw;
        vsubLimited = vsubRaw;
        icheckLimited = false;
      } else {
        // bjtload.c:383-416 — ichk1 OR-aggregation. BE gets &icheck, BC & VSUB
        // get &ichk1 which is then OR'd into icheck.
        const vbeResult = pnjlim(vbeRaw, s0[base + L1_SLOT_VBE], tpL1.vt, vcritBE);
        vbeLimited = vbeResult.value;
        vbeLimFlag = vbeResult.limited;
        let icheck = vbeLimFlag ? 1 : 0;

        let ichk1 = 1;
        const vbcResult = pnjlim(vbcRaw, s0[base + L1_SLOT_VBC], tpL1.vt, vcritBC);
        vbcLimited = vbcResult.value;
        vbcLimFlag = vbcResult.limited;
        ichk1 = vbcLimFlag ? 1 : 0;
        if (ichk1 === 1) icheck = 1;

        const vsubResult = pnjlim(vsubRaw, s0[base + L1_SLOT_VSUB], tpL1.vt, tpL1.tSubVcrit);
        vsubLimited = vsubResult.value;
        vsubLimFlag = vsubResult.limited;
        ichk1 = vsubLimFlag ? 1 : 0;
        if (ichk1 === 1) icheck = 1;

        icheckLimited = icheck === 1;
      }
```

**ngspice citation:** `bjtload.c:232–322, 383–416`.

### Diff B3 — MODEINITSMSIG linearization storage block

**NEW (inserted after the pnjlim section, before the `computeSpiceL1BjtOp` call):**
```ts
      // bjtload.c:236-244 + 671-703 — MODEINITSMSIG:
      // 1. Use vbe/vbc from state0 (already there — skipLimit=true leaves them).
      // 2. After I-V eval + charge calc, write small-signal cap companion
      //    currents and cexbc=geqcb into state0 and `continue`.
      // We evaluate the op point normally, then the SMSIG writeback happens
      // after the charge block (see Step 8 conditional).
```

Then after the capacitance block (before the stamping), add:
```ts
      // bjtload.c:676-703 — MODEINITSMSIG linearization store + skip stamp.
      if (ctx.initMode === "initSmsig") {
        // Write cap companions into state0 (they've been computed above).
        // In our architecture the cap companion slots are already s0-stored by
        // niIntegrate; this block exists only to skip the stamp phase. The
        // corresponding ngspice fields are cqbe/cqbc/cqsub/cqbx + cexbc=geqcb.
        // Our L1_SLOT_CAP_IEQ_* slots are the equivalent.
        s0[base + L1_SLOT_GEQCB] = geqcb_dc; // cexbc = geqcb (bjtload.c:681)
        return; // skip stamp phase — matches bjtload.c:703 `continue`
      }
```

**ngspice citation:** `bjtload.c:236–244, 671–703`.

### Diff B4 — Bypass test (port bjtload.c:338–382)

**NEW (inserted between pnjlim section and `computeSpiceL1BjtOp`):**
```ts
      // bjtload.c:338-382 — NOBYPASS bypass test with 4 tolerance checks.
      let bypassed = false;
      if (ctx.bypass && ctx.initMode !== "initPred" && !skipLimit) {
        const cc_prev  = s0[base + L1_SLOT_IC];
        const cb_prev  = s0[base + L1_SLOT_IB];
        const gm_prev  = s0[base + L1_SLOT_GM];
        const go_prev  = s0[base + L1_SLOT_GO];
        const gpi_prev = s0[base + L1_SLOT_GPI];
        const gmu_prev = s0[base + L1_SLOT_GMU];
        const vbe_prev = s0[base + L1_SLOT_VBE];
        const vbc_prev = s0[base + L1_SLOT_VBC];
        const delvbe = vbeLimited - vbe_prev;
        const delvbc = vbcLimited - vbc_prev;
        const cchat = cc_prev + (gm_prev + go_prev) * delvbe - (go_prev + gmu_prev) * delvbc;
        const cbhat = cb_prev + gpi_prev * delvbe + gmu_prev * delvbc;
        if (Math.abs(delvbe) < ctx.reltol * Math.max(Math.abs(vbeLimited), Math.abs(vbe_prev)) + ctx.voltTol &&
            Math.abs(delvbc) < ctx.reltol * Math.max(Math.abs(vbcLimited), Math.abs(vbc_prev)) + ctx.voltTol &&
            Math.abs(cchat - cc_prev) < ctx.reltol * Math.max(Math.abs(cchat), Math.abs(cc_prev)) + ctx.iabstol &&
            Math.abs(cbhat - cb_prev) < ctx.reltol * Math.max(Math.abs(cbhat), Math.abs(cb_prev)) + ctx.iabstol) {
          bypassed = true;
          // bjtload.c:365-380 — reload state0 values and goto load.
          vbeLimited = vbe_prev;
          vbcLimited = vbc_prev;
          vsubLimited = s0[base + L1_SLOT_VSUB];
          // GPI, GMU, GM, GO, IC, IB, GEQCB, GDSUB, CDSUB are already in state0.
        }
      }
      if (!bypassed) {
        s0[base + L1_SLOT_VBE] = vbeLimited;
        s0[base + L1_SLOT_VBC] = vbcLimited;
        s0[base + L1_SLOT_VSUB] = vsubLimited;

        const op = computeSpiceL1BjtOp(/* ... existing args ... */);
        /* ... existing writeback of OP slots and gpi/gmu/gm/go/ic/ib ... */
      }
      // If bypassed, proceed directly to stamping using state0-cached values.
```

Then guard the geqcb_dc/substrate/cap/excess-phase block on `!bypassed`:
```ts
      if (!bypassed) {
        // --- Step 5: geqcb_dc ... ---
        // --- Step 7: Substrate diode DC ---
        // --- Step 8: Junction cap NIintegrate ---
        // --- Step 9: Excess phase ---
      }
      // --- Step 10: Stamp — always runs, but reads state0 slots for linearization.
```

**ngspice citation:** `bjtload.c:338–382`.

### Diff B5 — noncon gate with INITFIX/off exception

**OLD (line 1538):**
```ts
      if (icheckLimited) ctx.noncon.value++;
```

**NEW (moved into non-bypassed path, gated correctly):**
```ts
      // bjtload.c:749-754 — noncon gate.
      const nonconGate = !(ctx.initMode === "initFix" && params.OFF !== 0);
      if (icheckLimited && nonconGate) ctx.noncon.value++;
```

**ngspice citation:** `bjtload.c:749–754`.

### Diff B6 — Drop Math.exp(..., 700) clamps in computeSpiceL1BjtOp, geqcb_dc, substrate diode, XTF expTerm, excess-phase expTermRun/expTermInit

**OLD (lines 1016, 1028, 1054, 1075, 1607, 1659, 1703, 1901, 1934):**
```ts
const expVbe = Math.exp(Math.min(vbe / nfVt, 700));
```
etc.

**NEW:**
```ts
const expVbe = Math.exp(vbe / nfVt);
```
Apply to all sites. **Rationale:** ngspice has no clamp; the polynomial tail at `vbe >= -3*vtn` handles the reverse-bias branch. For forward bias, overflow is unlikely in well-conditioned circuits; the clamp distorts the NR iteration trajectory.

**ngspice citation:** `bjtload.c:423, 437, 453, 467, 488`.

### Diff B7 — Fix Norton RHS `(op.gmu + op.go)` → `(op.go - geqcb_now)` at colPrime

**OLD (line 1628):**
```ts
      s0[base + L1_SLOT_IC_NORTON] = op.ic - (op.gm + op.go) * vbeLimited + (op.gmu + op.go) * vbcLimited;
```

Per bjtload.c:805, `ceqbc = type*(-cc + vbe*(gm+go) - vbc*(gmu+go))`, and this is pushed to `colPrimeNode` together with `ceqbx`. ngspice at line 803–804 defines `ceqbe = type*(cc + cb - vbe*(gm+go+gpi) + vbc*(go-geqcb))`.

Our `IC_NORTON` is supposed to be the C-terminal equivalent of `-ceqbc` (negative because RHS stamping convention). Let's derive:
- `ceqbc / type = -cc + vbe*(gm+go) - vbc*(gmu+go)`
- The stamp at colPrime is `+ (ceqbx + ceqbc)`. If we set `icNorton := -(ceqbc/type) = cc - vbe*(gm+go) + vbc*(gmu+go)` and stamp `-polarity * icNorton` at colPrime, we get `-polarity * (cc - vbe*(gm+go) + vbc*(gmu+go)) = -type * (cc - ...) = ceqbc - 2*polarity*cc`. **Sign-check required; our formula looks wrong.**

More precisely:
- ngspice stamps `+m*ceqbc` at colPrime. 
- Our code stamps `+m*(-polarity * icNorton)` at colPrime with `icNorton = op.ic - (op.gm+op.go)*vbe + (op.gmu+op.go)*vbc`.
- Setting these equal: `-polarity * icNorton = ceqbc = polarity * (-cc + vbe*(gm+go) - vbc*(gmu+go))`
- → `icNorton = cc - vbe*(gm+go) + vbc*(gmu+go)` ✓ **matches our line 1628** with `op.ic = cc`.

Wait — that's `+ (gmu+go)*vbc`. Our line 1628 says `+ (op.gmu + op.go) * vbcLimited`. **This matches.** So the formula is correct for IC_NORTON.

The `IB_NORTON` at line 1629 should equal `-ceqbe/polarity` (since basePrime stamps `+m*(-ceqbe-ceqbc)`, and we stamp `-polarity*ibNorton + -polarity*icNorton_neg` consolidated). Let's derive:
- `-ceqbe-ceqbc` at basePrime = `-type*(cc+cb-vbe*(gm+go+gpi)+vbc*(go-geqcb)) - type*(-cc+vbe*(gm+go)-vbc*(gmu+go))`
- = `type*(-cb + vbe*gpi - vbc*(go-geqcb) + vbc*(gmu+go))`
- = `type*(-cb + vbe*gpi + vbc*(gmu + geqcb))`

Our basePrime stamp: `-polarity * ibNorton` with `ibNorton = op.ib - op.gpi*vbe - op.gmu*vbc - geqcb_now*vbc`. 
`-polarity * ibNorton = polarity * (-cb + gpi*vbe + gmu*vbc + geqcb*vbc) = type * (-cb + gpi*vbe + (gmu+geqcb)*vbc)` ✓ **matches**.

And emitPrime: `IE_NORTON = -(ic+ib) + (gm+go+gpi)*vbe - (go-geqcb)*vbc`. ngspice stamps `+m*ceqbe = type*(cc+cb-vbe*(gm+go+gpi)+vbc*(go-geqcb))`. We stamp `-polarity*ieNorton`.
`-polarity*ieNorton = type*((ic+ib) - (gm+go+gpi)*vbe + (go-geqcb)*vbc)` ✓ (with ic=cc, ib=cb).

**Conclusion B19 is NOT a bug — formula is correct.** No diff needed. Retract B19 from the divergence list.

### Diff B8 — Fix CdBE diffusion cap to use raw gbe, not gm

**OLD (line 1711):**
```ts
          CdBE = tf_eff_base * op.gm;
```

**NEW:**
```ts
          // bjtload.c:617 — capbe = tf*gbe + czbe*sarg. gbe is the RAW BE
          // junction conductance (dIf/dVbe), NOT the Gummel-Poon transconductance gm.
          CdBE = tf_eff_base * op.gbe;
```

**ngspice citation:** `bjtload.c:617`.

### Diff B9 — Fix external BC cap stamp destination to baseNode + colPrimeNode

**OLD (lines 2048–2058):**
```ts
      if (hasCapacitance && ctx.isTransient) {
        const geqBCext = s0[base + L1_SLOT_CAP_GEQ_BC_EXT];
        const ieqBCext = s0[base + L1_SLOT_CAP_IEQ_BC_EXT];
        if (geqBCext !== 0 || ieqBCext !== 0) {
          stampG(solver, nodeB_ext, nodeB_ext, m * geqBCext);
          stampG(solver, nodeB_ext, nodeC_ext, m * -geqBCext);
          stampG(solver, nodeC_ext, nodeB_ext, m * -geqBCext);
          stampG(solver, nodeC_ext, nodeC_ext, m * geqBCext);
          stampRHS(solver, nodeB_ext, m * -polarity * ieqBCext);
          stampRHS(solver, nodeC_ext, m * polarity * ieqBCext);
        }
```

**NEW:**
```ts
      if (hasCapacitance && ctx.isTransient) {
        const geqBCext = s0[base + L1_SLOT_CAP_GEQ_BC_EXT];
        const ieqBCext = s0[base + L1_SLOT_CAP_IEQ_BC_EXT];
        if (geqBCext !== 0 || ieqBCext !== 0) {
          // bjtload.c:820, 822, 841, 842 — geqbx stamps are between baseNode
          // (EXTERNAL base) and colPrimeNode (INTERNAL collector), NOT external C.
          stampG(solver, nodeB_ext, nodeB_ext, m * geqBCext);
          stampG(solver, nodeB_ext, nodeC_int, m * -geqBCext);
          stampG(solver, nodeC_int, nodeB_ext, m * -geqBCext);
          stampG(solver, nodeC_int, nodeC_int, m * geqBCext);
          stampRHS(solver, nodeB_ext, m * -polarity * ieqBCext);
          stampRHS(solver, nodeC_int, m * polarity * ieqBCext);
        }
```

**ngspice citation:** `bjtload.c:820, 822, 841, 842` — `BJTbaseBasePtr += geqbx`, `BJTcolPrimeColPrimePtr += geqbx`, `BJTbaseColPrimePtr += -geqbx`, `BJTcolPrimeBasePtr += -geqbx`.

### Diff B10 — Add BJTsubs model parameter and use it for substrate stamping

**OLD (BJT_SPICE_L1_PARAM_DEFS, line 112-166):**
```ts
    CJS: { default: 0, unit: "F" }, VJS: { default: 0.75, unit: "V" }, MJS: { default: 0 },
    ISS: { default: 0, unit: "A" }, NS: { default: 1 },
```

**NEW:**
```ts
    CJS: { default: 0, unit: "F" }, VJS: { default: 0.75, unit: "V" }, MJS: { default: 0 },
    ISS: { default: 0, unit: "A" }, NS: { default: 1 },
    SUBS: { default: 1, description: "Substrate orientation (1=VERTICAL, -1=LATERAL)" },
```

**OLD (line 1248):**
```ts
    ISS: props.getModelParam<number>("ISS"),
    NS:  props.getModelParam<number>("NS"),
```

**NEW:**
```ts
    ISS: props.getModelParam<number>("ISS"),
    NS:  props.getModelParam<number>("NS"),
    SUBS: props.getModelParam<number>("SUBS"),
```

**OLD (line 1485):**
```ts
      const subs = polarity > 0 ? 1 : -1;
```

**NEW:**
```ts
      // bjtload.c:184-188 — BJTsubs is independent of NPN/PNP polarity.
      // Default VERTICAL (+1) for both polarities; LATERAL (-1) per model param.
      const subs = params.SUBS >= 0 ? 1 : -1;
```

**ngspice citation:** `bjtdefs.h:576–580`, `bjtload.c:184–188, 317–319`.

### Diff B11 — Add areab/areac parameters and use them in c4 calculation

**OLD (`computeBjtTempParams` param sig, lines 349–362):** does not include areab/areac; falls back to AREA.

ngspice `bjtload.c:184-187`: `if (VERTICAL) c4 = tBCleakCur * areab; else c4 = tBCleakCur * areac;`

**NEW:** Add `AREAB`, `AREAC` to `BJT_SPICE_L1_PARAM_DEFS` (defaults equal to AREA):
```ts
    AREA: { default: 1 },
    AREAB: { default: 1 }, // areab (ngspice): base area factor for VERTICAL BJT
    AREAC: { default: 1 }, // areac (ngspice): collector area factor for LATERAL BJT
    M: { default: 1 },
```

**OLD (in computeSpiceL1BjtOp caller, line 1569):**
```ts
        tpL1.tBEleakCur * params.AREA, tpL1.tBCleakCur * params.AREA,
```

**NEW:**
```ts
        // bjtload.c:184-187 — c2 = tBEleakCur * AREA (always); c4 uses areab
        // (VERTICAL) or areac (LATERAL). Default areab=areac=AREA when not given.
        tpL1.tBEleakCur * params.AREA,
        tpL1.tBCleakCur * (subs > 0 ? params.AREAB : params.AREAC),
```

Similarly adjust `tSubcap * params.AREA` at line 1739 and 1694:
- `czsub` (bjtload.c:582–585): VERTICAL → `tSubcap * areac`; LATERAL → `tSubcap * areab`.

**NEW (line 1739):**
```ts
          CtotalCS = computeJunctionCapacitance(vsubLimited, tpL1.tSubcap * (subs > 0 ? params.AREAC : params.AREAB), tpL1.tSubpot, mjs_eff, params.FC);
```

Same for `czsub = tpL1.tSubcap * (subs > 0 ? params.AREAC : params.AREAB);` at line 1742.

Also for BC cap (bjtload.c:573–576): VERTICAL → `tBCcap * areab`; LATERAL → `tBCcap * areac`.

**NEW (line 1727):**
```ts
          const CjBC = computeJunctionCapacitance(vbcLimited, tpL1.tBCcap * (subs > 0 ? params.AREAB : params.AREAC), tpL1.tBCpot, mjc_eff, params.FC);
```

**ngspice citation:** `bjtload.c:184–188, 573–585`.

### Diff B12 — Seed MODEINITTRAN bcopy for cqbe, cqbc, cqbx, cqsub

bjtload.c:735–740: `if(MODEINITTRAN) { state1[cqbe]=state0[cqbe]; state1[cqbc]=state0[cqbc]; }` and lines 764–770: same for cqbx, cqsub. Our code has partial (line 1785, 1809, 1841 handle CCAP_BE/BC/CS under `isFirstTranCall`), but these are `ccap` slots — not the ngspice `cqbe` equivalent. Our equivalent of `cqbe` is `CAP_IEQ_BE`. We do NOT seed `s1[CAP_IEQ_BE] = s0[CAP_IEQ_BE]` on initTran.

**OLD (after `if (isFirstTranCall) s1[base + L1_SLOT_CCAP_BE] = ccap;` line 1785):**
```ts
            if (isFirstTranCall) s1[base + L1_SLOT_CCAP_BE] = ccap;
```

**NEW (add):**
```ts
            if (isFirstTranCall) {
              s1[base + L1_SLOT_CCAP_BE] = ccap;
              // bjtload.c:735-740 — cqbe state1 bcopy on INITTRAN.
              s1[base + L1_SLOT_CAP_IEQ_BE] = ceq;
            }
```

Same for BC (add `s1[base + L1_SLOT_CAP_IEQ_BC_INT] = xcjc * ceq; s1[base + L1_SLOT_CAP_IEQ_BC_EXT] = (1-xcjc) * ceq;` in the isFirstTranCall block) and CS.

**ngspice citation:** `bjtload.c:735–740, 764–770`.

### Diff B13 — Remove `Math.exp(..., 700)` clamps

Same as Diff B6 (already listed) — apply to all L1 sites.

### Diff B14 — MODEINITTRAN vsub default

ngspice `bjtload.c:251-253`: vsub from rhsOld during MODEINITTRAN. Our B2 rewrite already handles this (`vsubRaw = vsubRawNode` in the initTran branch). Covered.

### Diff B15 — MODEINITTRAN cexbc bcopy

ngspice `bjtload.c:532–535`: during `MODEINITTRAN` with `td != 0`:
```
state1[cexbc] = cbe/qb;
state2[cexbc] = state1[cexbc];
```
Our code seeds `CEXBC_NOW/PREV/PREV2` (lines 1939–1941) when `prevDt <= 0`. The trigger is `prevDt <= 0`, which for the very first transient call is true. But we also need the shift history at lines 1945–1947 to run only after `prevDt > 0` (the normal filter path). Currently lines 1945–1947 run unconditionally — meaning on the init branch we then shift PREV2=PREV, PREV=NOW, which overwrites PREV2 with the init value of PREV (also the init value) → still the init value; mathematically benign but structurally odd.

**OLD (lines 1925–1947):**
```ts
            } else {
              // MODEINITTRAN: initialize history (bjtload.c:508-510)
              ... existing init of CEXBC_NOW/PREV/PREV2 ...
            }

            // Shift history
            s0[base + L1_SLOT_CEXBC_PREV2] = s0[base + L1_SLOT_CEXBC_PREV];
            s0[base + L1_SLOT_CEXBC_PREV] = s0[base + L1_SLOT_CEXBC_NOW];
            s0[base + L1_SLOT_DT_PREV] = dt;
```

**NEW:**
```ts
            } else {
              // bjtload.c:531-535 — MODEINITTRAN: state1[cexbc]=cbe/qb, state2=state1.
              const opIf = op.If;
              const opQb = op.qb;
              let initArgtf = 0;
              if (tf_eff_base > 0 && params.XTF > 0 && vbeLimited > 0) {
                const ITF_safe = Math.max(params.ITF * params.AREA, 1e-30);
                const icRatioInit = opIf / (opIf + ITF_safe);
                const VTF_safe = params.VTF === Infinity ? 1e30 : params.VTF;
                const expTermInit = Math.exp(vbcLimited / (1.44 * VTF_safe));
                initArgtf = params.XTF * icRatioInit * icRatioInit * expTermInit;
              }
              const cbe_mod_init = opIf * (1 + initArgtf) / Math.max(opQb, 1e-30);
              const cexbc_init = opQb > 1e-30 ? cbe_mod_init / opQb : 0;
              s0[base + L1_SLOT_CEXBC_NOW] = cexbc_init;
              s1[base + L1_SLOT_CEXBC_PREV] = cexbc_init;   // bjtload.c:532
              s2[base + L1_SLOT_CEXBC_PREV] = cexbc_init;   // bjtload.c:533 (state2)
            }

            // Shift history ONLY on normal filter path (prevDt > 0). On init
            // the seed is already placed into s1/s2 above.
            if (prevDt > 0) {
              s0[base + L1_SLOT_CEXBC_PREV2] = s0[base + L1_SLOT_CEXBC_PREV];
              s0[base + L1_SLOT_CEXBC_PREV] = s0[base + L1_SLOT_CEXBC_NOW];
            }
            s0[base + L1_SLOT_DT_PREV] = dt;
```

**ngspice citation:** `bjtload.c:525–543`.

### Diff B16 — Substrate diode gmin guard correctness

**OLD (lines 1668–1671):**
```ts
      } else {
        gdsub = GMIN;
        cdsub = GMIN * vsubLimited;
      }
```

ngspice always computes `gdsub = csubsat*... + CKTgmin` even when csubsat=0. When `csubsat=0`, ngspice: `gdsub = CKTgmin`, `cdsub = CKTgmin*vsub`. **Matches our else branch.** OK.

But the THEN branch at line 1660: `gdsub = csubsat * evsub / vts + GMIN` — this is correct. OK.

No diff.

### Diff B17 — Excess phase expTerm uses `(Math.min(vbcLimited/(1.44*VTF), 700))`

Covered by B6 clamp removal.

### Diff B18 — Normalize geqcb_dc formula (verify cbe_mod definition)

Already verified (section B27 of Deliverable 2): our formula matches bjtload.c:608. **No diff.**

### Diff B19 — MODEINITJCT MODETRANOP MODEUIC branch uses `polarity * ICVBE` consistently

The issue: `params.ICVBE` is stored as the user-given value. ngspice at bjtload.c:260 does `vbe = model->BJTtype * here->BJTicVBE`. `BJTtype = NPN=+1 | PNP=-1`. Our `polarity` matches BJTtype. But at line 1500, we set `vbeRaw = params.ICVBE;` without multiplying by polarity. **For PNP, ICVBE should be negative in the user's convention, and we'd multiply by polarity=-1 to get the Gummel-Poon-internal positive value.**

Diff B2 rewrite (above) already uses `vbeRaw = polarity * params.ICVBE` — ✓ fixed.

### Diff B20 — Ensure `applyInitialValues` for L1 schema does NOT pre-seed VBE=0.6 during reactive-first-solve

Line 1131: `VBE init from params: polarity === 1 ? 0.6 : -0.6`. bjtload.c does NOT seed vbe pre-iter-0 — it seeds inside INITJCT. Our schema initial seed is fine because the first call is `initJct` which overwrites. But the seed value gets written to both state0 AND state1 (via rotation). On the NEXT timestep, s1[VBE] holds the overwritten initJct seed (tVcrit), which is then used by initPred. OK.

**No diff.**

### Diff B21 — Fix excess-phase `arg3` definition

**OLD (line 1893):**
```ts
              const arg3 = r3sq / denom;
```

bjtload.c:530: `arg3 = arg1 / denom;` where `arg1 = arg2 * arg1 = 3*r*(r = dt/td) = 3*r^2` (after the redefinition at line 528). So `arg3 = (3*r^2) / denom`. Our `r3sq = 3*r*r = 3*r^2`, so `arg3 = r3sq / denom` ✓ **matches**.

No diff.

### Diff B22 — Fix `cex = cbe * arg3` using the post-XTF cbe

**OLD (lines 1904–1905):**
```ts
              const cbe_mod_run = opIf * (1 + argtf_run) / Math.max(opQb, 1e-30);
              const cex = cbe_mod_run * arg3;
```

bjtload.c:540: `cex = cbe * arg3` where at that line `cbe` has already been XTF-modified at line 608: `cbe = cbe*(1+argtf)/qb`. Our `cbe_mod_run = opIf*(1+argtf_run)/opQb` — matches (cbe_raw = If = opIf).

**But wait**: ngspice line 540 `cex = cbe * arg3`. At that point `cbe` is the XTF-modified cbe from line 608, which still needs to be divided by qb (line 608 does that). Let me re-read ngspice bjtload.c:591-611:

```
if(tf != 0 && vbe >0) {
    argtf=0;
    ...
    cbe=cbe*(1+argtf)/qb;     // line 608
    gbe=(gbe*(1+arg2)-cbe*dqbdve)/qb;
    geqcb=tf*(arg3-cbe*dqbdvc)/qb;
}
```

So at bjtload.c:540, `cbe` has NOT yet been XTF-modified — the `tf != 0 && vbe > 0` block at line 591 runs AFTER the excess-phase block at line 525. Let me re-check ordering...

bjtload.c ordering:
- Line 419: `next1:` (SenCond entry)
- Lines 420–448: cbe = csat*(evbe-1), gbe, cben, gben, gben+=CKTgmin
- Lines 450–478: cbc, gbc, cbcn, gbcn, gbcn+=CKTgmin
- Lines 480–491: substrate diode
- Lines 493–517: base charge qb
- Lines 519–543: **EXCESS PHASE** — uses `cbe` (raw, no XTF modification), `cex=cbe*arg3`, `gex=gbe*arg3`
- Lines 547–548: `cc = cc + (cex-cbc)/qb - cbc/BetaR - cbcn; cb = ...`
- Line 550+: gx, gpi, gmu, gm, go
- Lines 561+: conditional block, including line 591-611 `if(tf != 0 && vbe > 0) { ... cbe = cbe*(1+argtf)/qb; ... }`

**So at the excess-phase block, `cbe` is the RAW junction current `csat*(evbe-1)` — NOT XTF-modified.** Our `cbe_mod_run = opIf * (1+argtf_run) / opQb` is WRONG — it should be `cbe_raw = opIf`.

**OLD (lines 1896–1906):**
```ts
              let argtf_run = 0;
              if (tf_eff_base > 0 && params.XTF > 0 && vbeLimited > 0) {
                const ITF_safe_run = Math.max(params.ITF * params.AREA, 1e-30);
                const icRatioRun = opIf / (opIf + ITF_safe_run);
                const VTF_safe_run = params.VTF === Infinity ? 1e30 : params.VTF;
                const expTermRun = Math.exp(Math.min(vbcLimited / (1.44 * VTF_safe_run), 700));
                argtf_run = params.XTF * icRatioRun * icRatioRun * expTermRun;
              }
              const cbe_mod_run = opIf * (1 + argtf_run) / Math.max(opQb, 1e-30);
              const cex = cbe_mod_run * arg3;
              s0[base + L1_SLOT_CEXBC_NOW] = cc + (opQb > 1e-30 ? cex / opQb : 0);
```

**NEW:**
```ts
              // bjtload.c:540 — cex = cbe * arg3 where cbe is RAW csat*(evbe-1);
              // the XTF modification at bjtload.c:608 happens AFTER the excess-
              // phase block, so argtf does NOT enter here.
              const cex = opIf * arg3;
              // bjtload.c:542 — state0[cexbc] = cc + cex/qb.
              s0[base + L1_SLOT_CEXBC_NOW] = cc + (opQb > 1e-30 ? cex / opQb : 0);
```

**ngspice citation:** `bjtload.c:523–542`.

### Diff B23 — Fix gex/gm filter in excess-phase to use raw gbe

**OLD (lines 1908–1919):**
```ts
              // bjtload.c:540-541,559-560: filter gbe conductance and recompute gm/go
              const gex = op.gbe * arg3;
              const cexRaw = opIf * arg3;
              const cbcRaw = op.Ir;
              const gbcRaw = op.gbc;
              const dqbdvc_run = op.dqbdvc;
              const dqbdve_run = op.dqbdve;
              const qbSafe = Math.max(opQb, 1e-30);
              const go_filt = (gbcRaw + (cexRaw - cbcRaw) * dqbdvc_run / qbSafe) / qbSafe;
              const gm_filt = (gex - (cexRaw - cbcRaw) * dqbdve_run / qbSafe) / qbSafe - go_filt;
              s0[base + L1_SLOT_GM] = gm_filt;
              s0[base + L1_SLOT_GO] = go_filt;
```

bjtload.c:559–560 (AFTER the excess-phase block, using the post-phase `cex`, `gex`):
```
go=(gbc+(cex-cbc)*dqbdvc/qb)/qb;
gm=(gex-(cex-cbc)*dqbdve/qb)/qb-go;
```

Our formula matches structurally. **No diff** — already correct.

### Diff B24 — Raise SUBS-aware stamping and substrate area scaling for CS cap and BC cap

Covered by Diff B11 above.

### Diff B25 — Add `BJTsubs` / SUBS model parameter plumbing for PNP presets

**OLD (PNP_TIP32C, line 289):** no SUBS field.

**NEW:** Add `SUBS: 1` or `SUBS: -1` per datasheet. For general-purpose BJT presets, ngspice default VERTICAL (+1) applies. Only add SUBS to presets that need LATERAL.

### Diff B26 — Correct XTF-dependent `cbe_mod` for cap diffusion

**OLD (lines 1697–1715):** Our CdBE formula when `XTF>0` uses `gbe_mod = (gbe*(1+arg2) - cbe_mod*dqbdve)/qb` and `CdBE = tf*gbe_mod`.

bjtload.c:617: `capbe = tf*gbe + czbe*sarg`, where at that line `gbe` is the XTF-modified gbe from line 609: `gbe=(gbe*(1+arg2)-cbe*dqbdve)/qb`. Our formula matches.

**No diff for L1; but for the non-XTF path at line 1711 (`CdBE = tf_eff_base * op.gm`), see Diff B8 — must use `op.gbe`, not `op.gm`.**

### Diff B27 — Add BJTvceMax / BJTvbeMax / BJTvbcMax soft-breakdown checks

bjtdefs.h:454–456: ngspice has `BJTvbeMax`, `BJTvbcMax`, `BJTvceMax` params for soft-breakdown warnings via `BJTsoachk`. Our model does not implement SOA checking. **Scope-omit, documented.**

### Diff B28 — Add polynomial temperature-coefficient handling

bjtdefs.h:383–433: tlev, tlevc, tbf1/tbf2, tbr1/tbr2, tikf1/tikf2, etc., for polynomial temperature coefficients. Our `computeBjtTempParams` uses `XTB` exponential only. **Scope-omit for non-tlev simulations.**

### Diff B29 — Add excess-phase unconditional computation when `PTF > 0`

**OLD (line 461):**
```ts
  const excessPhaseFactor = (p.PTF > 0 && p.TF > 0) ? (p.PTF / (180 / Math.PI)) * p.TF : 0;
```

bjtload.c:189: `td = model->BJTexcessPhaseFactor;` — set by bjttemp.c unconditionally. The division-by-zero concern is in bjtload.c:526 `arg1 = CKTdelta/td` — so `td` MUST be non-zero to enter that branch, gated by `td != 0`. Our guard `p.PTF > 0 && p.TF > 0` is fine because if both are zero, td=0, branch not entered. But if PTF=0 and TF>0, td=0, branch skipped ✓. If PTF>0 and TF=0, td=0, branch skipped ✓. **No functional diff.**

### Diff B30 — Correct model-default FC handling in tDepCap

Our code: `tDepCap = p.FC * tBEpot` (line 438). ngspice `bjttemp.c:238`: `tDepCap = FC * tBEpot`. ✓

But ngspice also has `tf4 = FC * tBCpot` (line 442). ✓ matches.

### Diff B31 — Store `CEXBC` slot as `geqcb` during MODEINITSMSIG

Covered by Diff B3.

### Diff B32 — Emit convergence blame (CKTtroubleElt) on icheck fail

bjtload.c:752: `ckt->CKTtroubleElt = (GENinstance *) here;` when `icheck==1`. Our `ctx.noncon.value++` does not track blame. Framework-level divergence; out-of-scope for BJT model itself but noted.

### Diff B33 — Use tBEpot-specific VJE/VJC crit voltages

ngspice uses `here->BJTtVcrit` for both BE and BC (line 389, 398). The tVcrit is derived from IS (single-junction). This is OK for both junctions because ngspice uses the same critical voltage. **No diff.**

### Diff B34 — Add limiting record hook for ni_limit_record

bjtload.c:392–393: `ni_limit_record(di, 1, vbe_before, vbe);` — debug instrumentation (junctionId 1=BE, 2=BC, 8=VSUB). We have `ctx.limitingCollector.push` with explicit `junction: "BE"`. **Maps, with VSUB missing.** Add VSUB to our collector:

**OLD (lines 1540–1559):**
```ts
      if (ctx.limitingCollector) {
        ctx.limitingCollector.push({ /* BE */ });
        ctx.limitingCollector.push({ /* BC */ });
      }
```

**NEW:**
```ts
      if (ctx.limitingCollector) {
        ctx.limitingCollector.push({ elementIndex: (this as any).elementIndex ?? -1, label: (this as any).label ?? "", junction: "BE", limitType: "pnjlim", vBefore: vbeRaw, vAfter: vbeLimited, wasLimited: vbeLimFlag });
        ctx.limitingCollector.push({ elementIndex: (this as any).elementIndex ?? -1, label: (this as any).label ?? "", junction: "BC", limitType: "pnjlim", vBefore: vbcRaw, vAfter: vbcLimited, wasLimited: vbcLimFlag });
        ctx.limitingCollector.push({ elementIndex: (this as any).elementIndex ?? -1, label: (this as any).label ?? "", junction: "CS", limitType: "pnjlim", vBefore: vsubRaw, vAfter: vsubLimited, wasLimited: vsubLimFlag });
      }
```

**ngspice citation:** `bjtload.c:391–413`.

### Diff B35 — Remove unused `delvbe`/`delvbc` in checkConvergence when `icheckLimited`

**OLD (lines 2069–2101):** checkConvergence branches on `icheckLimited` first. If not limited, computes cchat/cbhat. This matches ngspice-style BJTconvTest semantics. **No diff.**

---

## Deliverable 5 — Additional divergences surfaced (F-BJT)

### F-BJT-ADD-1 — Missing polynomial temperature coefficients (TLEV/TLEVC path)
ngspice supports TLEV, TLEVC, TBF1, TBF2, TBR1, TBR2, TIKF1, TIKF2, TIKR1, TIKR2, TIRB1, TIRB2, TNC1, TNC2, TNE1, TNE2, TNF1, TNF2, TNR1, TNR2, TRB1, TRB2, TRC1, TRC2, TRE1, TRE2, TRM1, TRM2, TVAF1, TVAF2, TVAR1, TVAR2, CTC, CTE, CTS, TVJC, TVJE, TVJS, TITF1, TITF2, TTF1, TTF2, TTR1, TTR2, TMJE1, TMJE2, TMJC1, TMJC2, TMJS1, TMJS2, TNS1, TNS2, TIS1, TIS2, TISE1, TISE2, TISC1, TISC2. Our `computeBjtTempParams` implements only the `XTB` exponential path.

### F-BJT-ADD-2 — Missing SOA (vbeMax/vbcMax/vceMax) checks
bjtdefs.h:454–456. Our model ignores these. Ngspice `bjtsoachk.c` emits warnings when operating point exceeds limits.

### F-BJT-ADD-3 — Missing noise stamp (`bjtnoise.c`)
Seven noise sources: BJTRCNOIZ, BJTRBNOIZ, BJT_RE_NOISE, BJTICNOIZ, BJTIBNOIZ, BJTFLNOIZ, BJTTOTNOIZ. Our L1 has `KF`/`AF` params but no noise stamp pathway.

### F-BJT-ADD-4 — Missing distortion coefficients (`bjtdisto.c`)
65 `BJTdCoeffs[]` for multidimensional Taylor expansion (ic_x, ic_y, etc.). Used for `.disto` analysis. Not implemented.

### F-BJT-ADD-5 — Missing AC small-signal stamp (`bjtacld.c`)
AC load uses the same linearization but with complex `jω` multipliers on capacitance stamps. Our architecture's `isTransient` / AC handling must mirror; bjtload.c relies on NIintegrate writing into `CKTmatrix` complex entries, which our code handles via the shared MNA stamping (likely OK but should be cross-audited).

### F-BJT-ADD-6 — Missing `BJTgetic` initial-condition propagation
`bjtgetic.c`: when UIC given, transfers ICVBE/ICVCE into state vectors at DC-OP init. Our code reads `params.ICVBE/ICVCE` directly in initJct; mostly equivalent.

### F-BJT-ADD-7 — Missing `BJTtrunc` local truncation error
`bjttrunc.c`: calls `CKTterr(BJTqbe, ...)`, `CKTterr(BJTqbc, ...)`, `CKTterr(BJTqbx, ...)`, `CKTterr(BJTqsub, ...)`. Our `getLteTimestep` calls `cktTerr` on Q_BE, Q_BC, Q_CS (conditionally). **Missing: Q_BX (external BC charge).** Our model stores only the combined BC charge and splits via XCJC at stamp time, not at charge-history time. This is a subtle LTE divergence.

### F-BJT-ADD-8 — Missing convergence blame tracking `CKTtroubleElt`
bjtload.c:752 sets `ckt->CKTtroubleElt = (GENinstance *) here` when icheck==1. Our `ctx.noncon.value++` does not propagate element identity. Framework-level fix required.

### F-BJT-ADD-9 — `CKTgmin` handling
ngspice `CKTgmin` is added to gben, gbcn (bjtload.c:447,477) AND to gdsub (line 489). Our `GMIN = 1e-12` constant is not tied to `CKTgmin` (which varies with gmin-stepping). **All BJT components must use `ctx.gmin` in place of the hardcoded `GMIN`.**

### F-BJT-ADD-10 — `vsubRaw` default for models without substrate node
Simple model does not expose substrate pin — intentional per spec. Document as model-scope limitation. L1 model uses `(0 - vSubConRaw)` assuming substrate tied to ground, which is ngspice's default when `substNode` is implicit ground. If a user wires the substrate to a non-ground node, our model cannot represent it.

### F-BJT-ADD-11 — `voltTol` availability
Bypass diff requires `ctx.voltTol` on `LoadContext`. Currently LoadContext has `reltol`, `abstol`, `iabstol` — no `voltTol`. Framework extension required (matches ngspice `CKTvoltTol`).

### F-BJT-ADD-12 — `CKTbypass` context flag
Bypass diff requires `ctx.bypass`. Currently LoadContext does not expose this. Framework extension required.

### F-BJT-ADD-13 — State slot VSUB/GDSUB/CDSUB ordering diverges from ngspice's 24-slot layout
Our L1 has 51 slots; ngspice has 24 + 8 sensitivity. Order differs (we interleave companion cap slots with linearization). Internal-to-us — no matrix-level impact but diverges from any debug tooling that reads state vectors by ngspice offsets.

### F-BJT-ADD-14 — Sensitivity (`senInfo`) not supported
Our BJT has no `CKTsenInfo` analog. All `BJT_QUEST_SENS_*` are not implementable. Scope-omit.

### F-BJT-ADD-15 — `applyInitialValues` seeds VBE/VBC to fixed 0.6/−0.6
`BJT_SIMPLE_SCHEMA` and `BJT_L1_SCHEMA` seed VBE from params with `compute: _p["polarity"] === 1 ? 0.6 : -0.6`. ngspice does not seed pre-INITJCT; state0/state1 default to zero. Our seed is benign because INITJCT overwrites on first call, but it propagates into s1/s2 via rotation and gives a non-ngspice initPred extrapolation on the first transient call. **Consider zeroing the schema default** for ngspice parity.

### F-BJT-ADD-16 — Stamp sign/polarity double-encoding
Our code uses `m * -polarity * icNorton` at colPrime (line 2034). ngspice uses `m * (ceqbx + ceqbc)` with `ceqbc = type*(-cc + ...)`. Verify double-polarity: we encode polarity once in `vbeRaw = polarity*(vB-vE)` and again in `-polarity * icNorton`. Algebraic audit (deliverable 2 B19) shows signs cancel — ✓ correct.

### F-BJT-ADD-17 — Missing `BJTtype` (NPN/PNP) as a model-param-validated quantity
Our polarity flag is factory-side (+1/-1); ngspice stores BJTtype in model struct and uses `model->BJTtype` inline in stamps. Functionally equivalent.

### F-BJT-ADD-18 — Missing `geqbx` Norton stamp as separate term
bjtload.c:801–802: `ceqbx = type * (state0[cqbx] - vbx*geqbx);` and stamped at lines 807, 809. Our L1 stamps `CAP_IEQ_BC_EXT` with `ieqBCext` but the Norton formula is ngspice-correct: the history current adjustment `-vbx*geqbx` is baked into `ieq` by niIntegrate (`ceq = ccap - ag[0]*q0` ≈ `ccap - geq*q0`). Verify companion model equivalence:
- ngspice `ceqbx = type * (cqbx - vbx*geqbx)` where `cqbx = ccap_from_NIintegrate` (niinteg.c).
- Our `ieqBCext = (1-xcjc) * ceq` where `ceq = ccap - ag[0] * q0`, and `geq = ag[0] * C`, so `ceq = ccap - geq * q0 / C_total` → but niIntegrate returns `ceq` already as "current minus geq*voltage_equivalent", matching ngspice's convention.

The question is whether `vbx` (externally-read base-collector-internal voltage) is used. ngspice line 325–327: `vbx = type*(rhsOld[baseNode] - rhsOld[colPrimeNode])`. Our Q_BC is computed from `vbcLimited = polarity*(vBi-vCi)` — internal-base vs internal-collector. **bjtload splits**: internal `qbc` between B' and C' uses `vbc`, external `qbx` between B (external) and C' uses `vbx`. We treat them as one `Q_BC` and split via XCJC at stamp.

**This is a subtle divergence.** ngspice evaluates the junction cap at two different voltages (vbc for internal portion, vbx for external portion). Our code evaluates at vbc only, then splits the resulting charge between stamp destinations. For FC-coupled caps where vbx ≈ vbc (normal operation, no external lead resistance biasing), the error is small. For extreme conditions (very high RB), the error grows. **Document and track.**

### F-BJT-ADD-19 — GMIN should scale with area/Rb
ngspice uses plain `CKTgmin` (not area-scaled) in all conductance additions. Our code uses plain GMIN. OK.

### F-BJT-ADD-20 — `Math.SQRT2` vs `sqrt(2)` in tVcrit formula
Our `tVcrit = vt * log(vt / (sqrt(2) * tSatCur * AREA))`. ngspice `bjttemp.c:258`: `tVcrit = vt * log(vt / (CONSTroot2 * tSatCur * area))`. ✓ matches.

### F-BJT-ADD-21 — Diffusion cap with vbe ≤ 0
bjtload.c:591: `if(tf != 0 && vbe > 0)`. Our guard at line 1697: `if (tf_eff_base > 0 && params.XTF > 0 && vbeLimited > 0)`. The ngspice gate is `tf != 0 && vbe > 0` — it runs even with XTF=0 (with `argtf=0`). Our gate additionally requires `XTF > 0`. For XTF=0, we fall through to `CdBE = tf_eff_base * op.gm` (bug — should be `op.gbe`, see Diff B8) without running the XTF modification of gbe that ngspice does. When XTF=0, ngspice at line 608: `cbe = cbe*(1+0)/qb = cbe/qb`; line 609: `gbe = (gbe*(1+0) - cbe*dqbdve)/qb = (gbe - cbe*dqbdve)/qb`.

**Our code skips the `gbe` adjustment when XTF=0.** This is a divergence for XTF=0 case.

**OLD (lines 1697–1715):**
```ts
        if (tf_eff_base > 0 && params.XTF > 0 && vbeLimited > 0) {
          const If_val = op.If;
          const gbe_raw = op.gbe;
          ... argtf, cbe_mod, gbe_mod ...
          CdBE = tf_eff_base * gbe_mod;
        } else {
          CdBE = tf_eff_base * op.gm;
          if (tf_eff_base > 0) {
            cbe_for_q = op.If / Math.max(op.qb, 1e-30);
          }
        }
```

**NEW:**
```ts
        // bjtload.c:591-611 — runs on `tf != 0 && vbe > 0` regardless of XTF.
        // With XTF=0, argtf=0 collapses to: cbe = cbe/qb; gbe = (gbe - cbe*dqbdve)/qb.
        if (tf_eff_base > 0 && vbeLimited > 0) {
          const If_val = op.If;
          const gbe_raw = op.gbe;
          let argtf = 0;
          let arg2 = 0;
          let arg3 = 0;
          if (params.XTF > 0) {
            argtf = params.XTF;
            if (params.VTF !== Infinity) {
              argtf *= Math.exp(vbcLimited / (1.44 * params.VTF));
            }
            arg2 = argtf;
            const xjtf = params.ITF * params.AREA;
            if (xjtf > 0) {
              const temp = If_val / (If_val + xjtf);
              argtf = argtf * temp * temp;
              arg2 = argtf * (3 - temp - temp);
            }
            arg3 = If_val * argtf * (params.VTF === Infinity ? 0 : 1 / (1.44 * params.VTF));
          }
          const cbe_mod = If_val * (1 + argtf) / Math.max(op.qb, 1e-30);
          cbe_for_q = cbe_mod;
          const gbe_mod = (gbe_raw * (1 + arg2) - cbe_mod * op.dqbdve) / Math.max(op.qb, 1e-30);
          CdBE = tf_eff_base * gbe_mod;
          // geqcb — bjtload.c:610, used in the stamping path below.
          // (stored elsewhere as L1_SLOT_GEQCB_DC)
        } else {
          CdBE = 0;
          cbe_for_q = 0;
        }
```

**ngspice citation:** `bjtload.c:591–611`.

### F-BJT-ADD-22 — `capsub` / `geqcb` stamp absent from our L1 stamping
bjtload.c:760 `NIintegrate(capsub, BJTqsub)` runs under `MODETRAN | MODEAC`, producing `gcsub` which is stamped at lines 823, 838, 839, 840 (substConNode/substNode four-entry pattern). Our CS cap stamps at lines 2062–2064 use `substConNode` only as a single-node conductance + RHS — **missing the substrate-to-substConNode coupling**.

**OLD (lines 2060–2065):**
```ts
        const geqCS = s0[base + L1_SLOT_CAP_GEQ_CS];
        const ieqCS = s0[base + L1_SLOT_CAP_IEQ_CS];
        if (geqCS !== 0 || ieqCS !== 0) {
          stampG(solver, substConNode, substConNode, m * geqCS);
          stampRHS(solver, substConNode, m * polarity * subs * ieqCS);
        }
```

**NEW:** Since our model ties substrate to ground (`vsubRaw = polarity * subs * (0 - vSubConRaw)`), stamping only at substConNode is conceptually correct (ground row has no matrix entry). But ngspice-parity requires allocating a substrate node and full 4-entry stamp:

```ts
        const geqCS = s0[base + L1_SLOT_CAP_GEQ_CS];
        const ieqCS = s0[base + L1_SLOT_CAP_IEQ_CS];
        if (geqCS !== 0 || ieqCS !== 0) {
          // bjtload.c:823, 838-840 — substSubst/substConSubst/substSubstCon
          // /substConSubstCon 4-entry substrate-diode stamp. With substrate
          // tied to ground, the ground rows drop out and only the substCon
          // self-term remains; this matches ngspice behavior when the
          // substrate node is ground. If allocated separately, the full
          // 4-entry pattern is needed.
          stampG(solver, substConNode, substConNode, m * geqCS);
          stampRHS(solver, substConNode, m * polarity * subs * ieqCS);
          // TODO (F-BJT-ADD-22): allocate explicit substrate node to match
          // ngspice's bjtload.c substrate stamp.
        }
```

### F-BJT-ADD-23 — `geqsub = gcsub + gdsub` aggregation in Norton
bjtload.c:798: `geqsub = gcsub + gdsub;` and `ceqsub = type*subs*(state0[cqsub] + cdsub - vsub*geqsub);`. Our code stamps `gdsub` and `geqCS` separately. Combine into `geqsub` to match ngspice's Norton-construction semantics:

**NEW (after computing gdsub/cdsub and geqCS/ieqCS):**
```ts
        // bjtload.c:798-800 — geqsub = gcsub + gdsub; ceqsub = type*subs*(cqsub + cdsub - vsub*geqsub).
        const geqsub_ng = (s0[base + L1_SLOT_CAP_GEQ_CS] ?? 0) + gdsub;
        const cqsub_ng = s0[base + L1_SLOT_CAP_IEQ_CS] ?? 0;
        const ceqsub_ng = polarity * subs * (cqsub_ng + cdsub - vsubLimited * geqsub_ng);
        // Replace separate stamps with single ngspice-form:
        stampG(solver, substConNode, substConNode, m * geqsub_ng);
        stampRHS(solver, substConNode, m * ceqsub_ng);
```

This replaces the two separate stamp sections (substrate-DC at lines 2041–2044 and CS-cap at 2060–2065).

**ngspice citation:** `bjtload.c:798–800, 810, 814, 823, 838–840`.

### F-BJT-ADD-24 — Missing `senPertFlag` and `senParmNo` bookkeeping
Sensitivity-related; scope-omit.

### F-BJT-ADD-25 — `isTransient` vs `MODETRAN|MODEAC` distinction
bjtload.c gates the capacitance block on `(MODETRAN | MODEAC) || (MODETRANOP && MODEUIC) || MODEINITSMSIG`. Our code uses `hasCapacitance && ctx.isTransient` — misses `MODEINITSMSIG` and `MODETRANOP && MODEUIC` paths. For DC-OP with UIC where caps should seed, our skip is wrong.

**Fix:** gate on `hasCapacitance && (ctx.isTransient || ctx.initMode === "initSmsig" || (ctx.isDcOp && pool.uic))`.

### F-BJT-ADD-26 — `integrate`-call ordering for qbe/qbc
bjtload.c:725 integrates qbe BEFORE qbc; qbc integration modifies `cb` and `cc`. Our code stamps BE and BC in order via `niIntegrate` (lines 1773, 1799) — matches.

### F-BJT-ADD-27 — `MODETRANOP && MODEUIC` path short-circuits charge computation
bjtload.c:674–675: `if (!(MODETRANOP) || !(MODEUIC)) { ... charge + stamp ... }`. The `SenCond && SENTRANSEN` `continue` at line 708–713 also skips the transient integration. Our code does not have this MODETRANOP+UIC gate. Potential divergence for UIC DC-OP.

---

## Summary of required infrastructure changes

To fully implement the diffs above, the following **framework-level** extensions are required (flagged for F-infra pass, not BJT-model-scope):

1. **`LoadContext.bypass: boolean`** (CKTbypass) — bypass is ngspice default-on.
2. **`LoadContext.voltTol: number`** (CKTvoltTol) — typically 1e-6.
3. **`LoadContext.gmin: number`** (CKTgmin) — dynamic under gmin-stepping.
4. **`LoadContext.deltaOld: readonly number[]`** — CKTdeltaOld[1] for xfact.
5. **`LoadContext.trouble: { element: AnalogElementCore | null }`** — CKTtroubleElt blame.

---

## References

- `C:/local_working_projects/digital_in_browser/ref/ngspice/src/spicelib/devices/bjt/bjtload.c:1–846` — full BJTload reference.
- `C:/local_working_projects/digital_in_browser/ref/ngspice/src/spicelib/devices/bjt/bjtdefs.h:289–313` — state-slot layout.
- `C:/local_working_projects/digital_in_browser/ref/ngspice/src/spicelib/devices/bjt/bjttemp.c` — temperature-coefficient formulas.
- `C:/local_working_projects/digital_in_browser/src/components/semiconductors/bjt.ts:619–973` — simple (spice-l0) model.
- `C:/local_working_projects/digital_in_browser/src/components/semiconductors/bjt.ts:1130–2169` — SPICE-L1 Gummel-Poon model.
- `C:/local_working_projects/digital_in_browser/src/components/semiconductors/bjt.ts:349–473` — `computeBjtTempParams` temperature scaling.
- `C:/local_working_projects/digital_in_browser/src/solver/analog/newton-raphson.ts:89–109` — `pnjlim` implementation (F5 scope).
- `C:/local_working_projects/digital_in_browser/src/solver/analog/load-context.ts:19–24` — `InitMode` enumeration.

**Primary bug findings with highest impact:**

1. **Diff B1 / B2 (initPred missing xfact + VSUB/GX copy)** — causes transient prediction error on every step, grows compounding error on stiff circuits. Bjtload.c:277–306.
2. **Diff B8 (CdBE uses op.gm instead of op.gbe)** — wrong diffusion cap for XTF=0 case, off by `dIf/dVbe vs gm` factor ≈ 1/BetaF to 1 ratio. Bjtload.c:617.
3. **Diff F-BJT-ADD-21 (XTF=0 gate skips gbe adjustment)** — wrong diffusion cap even without XTF. Bjtload.c:591–611.
4. **Diff B9 (external BC cap stamps wrong nodes: C_ext instead of C_int)** — charge leaks through wrong Jacobian entries, affects transient accuracy especially at high RC. Bjtload.c:820–842.
5. **Diff B22 (excess-phase cex uses XTF-modified cbe instead of raw cbe)** — excess phase filter fed wrong input; affects high-frequency RF simulations. Bjtload.c:540.
6. **Diff B4 (no bypass test)** — unnecessary computation, no correctness error but causes divergence in CKTnoncon timing relative to ngspice (affects test-harness parity).
7. **Diff B10 (SUBS wrongly derived from NPN/PNP)** — incorrect LATERAL vs VERTICAL orientation, affects areab/areac partitioning, cap distribution. Bjtload.c:184–188, 573–585.
8. **Diff A5 + Diff B5 (noncon gate missing INITFIX/off exception)** — spurious non-convergence flags when off==1 during initFix. Bjtload.c:749–754.

**Model-scope intentional divergences (documented, not fixed):**
- Simple model has no substrate — F5-G intentional.
- Temperature polynomial coefficients (TLEV/TLEVC) not implemented.
- Noise model not implemented.
- Distortion `.disto` coefficients not implemented.
- Sensitivity (`CKTsenInfo`) not implemented.
- SOA checking (`bjtsoachk`) not implemented.
- `BJTtrunc` Q_BX slot not separately tracked (split-at-stamp via XCJC).

agentId: aec39295276271c4d (use SendMessage with to: 'aec39295276271c4d' to continue this agent)
<usage>total_tokens: 198772
tool_uses: 16
duration_ms: 676857</usage>