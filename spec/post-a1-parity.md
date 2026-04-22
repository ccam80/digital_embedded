# Post-A1 Parity List

**Generated:** 2026-04-22
**Input:** Phase 2.5 W3 audit output — 24 parallel lanes (10 sonnet L1a+L1b, 12 haiku L1c, 1 haiku L2, 1 haiku L3)
**Method:** static line-by-line comparison (no harness run — see `spec/phase-2.5-execution.md §6.8`)
**Exit criterion of Phase 2.5:** this file committed; handoff to Phase 3+.

Every entry below is **PARITY** — bit-exact divergence from ngspice or spec that must be fixed. No middle verdicts, no tolerances. Findings cross-referenced to `spec/plan-addendum.md` Phase 3–9 REWRITE/PAUSE rows are noted but remain in this list so Phase 3+ authors see the complete surface.

---

## §1. Device parity findings (L1a + L1b)

### diode

**Coverage:** full `DIOload` (lines 21–445) vs `diode.ts::load()` (lines 463–664).

| # | ngspice ref:line | digiTS ref:line | Divergence | Severity |
|---|---|---|---|---|
| D-W3-1 | dioload.c:292–313 (IKF/IKR) | diode.ts:556–564 | `sqrtTerm = sqrt(1 + id/IKF)` (extra `+1` under radical); IKF correction applied only to `gd`, not to `id` — Norton pair inconsistent | **CRITICAL** |
| D-W3-2 | dioload.c:304–312 (IKR reverse path) | diode.ts:560–563 | same two bugs, reverse region | **CRITICAL** |
| D-W3-3 | dioload.c:141–149 (`#ifndef PREDICTOR` copy-then-rhsOld) | diode.ts:478–509 | MODEINITPRED block does not short-circuit to rhsOld; cascaded `if MODEINITSMSIG / else if MODEINITTRAN / else rhsOld` re-tests mode bits | MEDIUM |
| D-W3-4 | — | diode.ts:632 | `s0[SLOT_V]` written but never read in any subsequent load() path — vestigial slot | MEDIUM |
| D-W3-5 | dioload.c (cosmetic) | diode.ts:520 | breakdown gate uses `tBV < Infinity` (functionally equivalent to `DIObreakdownVoltageGiven`) | LOW |
| D-W3-6 | dioload.c:209–243 (sidewall current) | — | sidewall current (csatsw/cdsw/gdsw) absent; acceptable for discrete diodes | LOW |
| D-W3-7 | dioload.c:267–285 (tunnel current) | — | tunnel current (DIOtunSat*) absent; document in §I2 if VLSI parity needed | LOW |
| D-W3-8 | — | SLOT_CCAP | genuine cross-timestep integration-history slot (s0→s1 via rotation) corresponding to ngspice's `CKTstate1 + DIOcapCurrent`; **flag for architectural-alignment.md §I2 note** | — |

**D-1 carry-forward:** CONFIRMED ABSENT — no `Math.min(vd/nVt, 700)` or `Math.exp(700)` clamps. Closed.

**Cross-ref:** D-W3-3 PAUSE for plan-addendum 3.2.1 (re-authored post-A1). D-1 enumerated, now closed.

### zener

**Coverage:** `createZenerElement` (simplified model) vs `DIOload` breakdown-aware branches.

| # | ngspice ref:line | digiTS ref:line | Divergence | Severity |
|---|---|---|---|---|
| Z-W3-1 | dioload.c:245–265 (three-region structure) | zener.ts:208 | forward/breakdown split at `-BV` instead of `-3*vte`; entire reverse-cubic region (cubic approximation between forward and breakdown) missing | **CRITICAL** |
| Z-W3-2 | dioload.c:251–258 | zener.ts (absent) | reverse-cubic branch absent (`arg=3*vte/(vd*CONSTe); cdb=-csat*(1+arg^3); gdb=csat*3*arg^3/vd`) | **CRITICAL** |
| Z-W3-3 | dioload.c:297–299 (gmin as Norton pair) | zener.ts:213, 221 | gmin folded into `geq` only; ngspice adds to both `gd` AND corrects `cd += gmin*vd` | HIGH |
| Z-W3-4 | dioload.c:130–138 (4-branch MODEINITJCT dispatch) | zener.ts:172–175 | single MODEINITJCT branch; missing UIC, OFF, MODEINITFIX+OFF sub-branches | HIGH |
| Z-W3-5 | dioload.c:183 (DIObreakdownVoltageGiven flag) | zener.ts:520 matches 4.3.3 | `tBV < Infinity` used; 4.3.3 owns the `BV → tBV` temperature scaling | HIGH → plan-addendum 4.3.3 |
| Z-W3-6 | dioload.c:189–190 (breakdown pnjlim vcrit from `DIOtVcrit`) | zener.ts:180 | vcrit computed from forward `nVt`, not breakdown `nbvVt`; when NBV≠N the breakdown limit is wrong | MEDIUM |
| Z-W3-7 | dioload.c:417–419 (state0 stores gmin-adjusted cd/gd) | zener.ts:204, 215 | `SLOT_ID` stores pre-gmin `id`; `SLOT_GEQ` stores gmin-augmented geq — inconsistent with ngspice | MEDIUM |
| Z-W3-8 | dioload.c:126–128 (MODEINITSMSIG) | zener.ts (absent) | MODEINITSMSIG branch absent | MEDIUM |
| Z-W3-9 | dioload.c:128–129 (MODEINITTRAN state1 read) | zener.ts (absent) | MODEINITTRAN seeding absent | MEDIUM |

### capacitor

**Coverage:** full `CAPload` vs `capacitor.ts::load()`.

| # | ngspice ref:line | digiTS ref:line | Divergence | Severity |
|---|---|---|---|---|
| C-W3-1 | — | solver.stampElement semantics | MUST verify `stampElement(handle, val)` is additive (`+=`), not overwrite (`=`). Architectural, not capacitor-specific — affects every device | **CRITICAL (architectural)** |
| C-W3-2 | capload.c:44 + stamps w/ `m` factor | capacitor.ts:326–333 (no m at stamp time) | `M` folded into `C` via `_computeEffectiveC` instead of applied at stamp time per ngspice. Numerically identical for static M, but q-history slots (s1–s3 SLOT_Q) become stale on mid-sim `setParam("M", ...)` | MEDIUM |
| C-W3-3 | capload.c:69 (NIintegrate error return) | capacitor.ts (no error return) | `niIntegrate` silently falls through GEAR branch at order<1 instead of propagating `E_ORDER` | LOW |

**D-15 carry-forward:** CONFIRMED SATISFIED (`_IC: { default: 0.0 }` + unconditional cond1 use; no `isNaN` guard).
**2.4.5 carry-forward:** CONFIRMED SATISFIED (`MODETRAN|MODEAC|MODETRANOP` gate, no MODEDCOP).

### polarized-cap

**F4 classification:** F4b APPROVED FIX (architectural-alignment.md §F4b row: `cap/*` + `dio/*` reverse-bias clamp).

| # | ngspice ref:line | digiTS ref:line | Divergence | Severity |
|---|---|---|---|---|
| PC-W3-1 | arch-alignment.md §F4b | polarized-cap.ts (all) | **Entire `dio/*` reverse-bias clamp primitive absent.** Reverse-bias region is a polarity-warning diagnostic only; no MNA stamp. Second half of F4b composition is missing. | **CRITICAL** |
| PC-W3-2 | capload.c:30 (MODEAC in outer gate) | polarized-cap.ts:345 | `MODEAC` absent from outer participation gate — AC small-signal path skips companion stamp | HIGH |
| PC-W3-3 | capload.c:52 (inner MODEAC fork) | polarized-cap.ts:352 | `if(mode & MODETRAN)` instead of `if(mode & (MODETRAN|MODEAC))` — no NIintegrate call in AC | HIGH |
| PC-W3-4 | arch-alignment.md §F4b constraint §1 | — | No parity harness test file comparing matrix entries against ngspice CAPload | HIGH |
| PC-W3-5 | capload.c:46–51 (cond1 IC override) | polarized-cap.ts:264–271 | `cond1` IC path uses `this._IC` (default 0) — correct; but no stored `initCond` parameter | MEDIUM |
| PC-W3-6 | capload.c:44 (`m = CAPm`) | — | No multiplicity factor `m` / `CAPm` param — parallel-element scaling absent | MEDIUM |

**Ambiguity for user:** diode topology node choice (clamp sees full terminal vs. cap-node only, interacting with ESR topology). Post-A1 decision.

### inductor

**Coverage:** full `INDload` vs `inductor.ts::load()`.

| # | ngspice ref:line | digiTS ref:line | Divergence | Severity |
|---|---|---|---|---|
| I-W3-1 | indload.c:45–46 (`L/m * CKTrhsOld[INDbrEq]`) | inductor.ts:285–289 | **Flux seeded from `voltages[b]` (current NR iterate) instead of `ctx.rhsOld[b]` (prior accepted solution).** Rewrites SLOT_PHI every NR sub-iteration, corrupting NIintegrate inputs. **Directly explains `rl_dc_steady_state_tight_tolerance: 97.56 vs <0.1` (watch item from prior §6.5).** | **CRITICAL** |
| I-W3-2 | indload.c:43–44 (one UIC branch inside non-MODEDC gate) | inductor.ts:271–272 | Spurious `(MODEDC & MODEINITJCT)` arm added to cond1; fires at DC-OP, forces `iNow = NaN` (`_IC` default NaN) into flux write | HIGH |
| I-W3-3 | indload.c:114–117 (state1[INDvolt] = state0[INDvolt] on MODEINITTRAN) | inductor.ts (absent) | `SLOT_VOLT` never copied s0→s1 on MODEINITTRAN — stale zero on second transient step | MEDIUM |
| I-W3-4 | — | inductor.ts:340 stampRHS | MUST verify `solver.stampRHS(row, val)` is additive | MEDIUM (arch) |
| I-W3-5 | indload.c (no s1 INDflux copy pattern match) | inductor.ts:291–292 structural | MODEINITPRED / MODEINITTRAN state-copy ordering differs from ngspice (pure structure; functional equivalence for current case, but any future extension diverges) | LOW |
| I-W3-6 | — | SLOT_CCAP (slot 4, digiTS-only) | genuine cross-timestep integration history (maps to ngspice's `CKTstate1 + INDflux` implicit in NIintegrate) — **flag for architectural-alignment.md §I2 note** | — |

**rl_dc_steady_state classification:** inductor-side primary (I-W3-1), B5 solver contribution not ruled out.

### transformer

**F4 classification:** F4a per architectural-alignment.md §F4a (coupled inductors — FIX).

| # | ngspice ref:line | digiTS ref:line | Divergence | Severity |
|---|---|---|---|---|
| T-W3-1 | — (compiler) | transformer.ts:608 `branchCount:1` | **`branchCount: 1` but device uses 2 MNA branch rows (`branch2 = branch1 + 1`).** Second winding aliases next element's branch or an unallocated slot. Every `b2` stamp and read targets wrong index. Breaks every circuit containing a transformer. | **CRITICAL** |
| T-W3-2 | indload.c:88–109 | transformer.ts:361 | Integration gate is `MODETRAN`, not `!MODEDC` — zeros all g/hist at MODEINITTRAN (before `MODETRAN` bit is set), zeroing companion stamps on first transient step | **CRITICAL** |
| T-W3-3 | indload.c:108 (NIintegrate) | transformer.ts:370–384 | **NIintegrate never called — manual ag-expansion omits `ccapPrev` and SLOT_CCAP tracking.** BDF-2 history wrong from step 2 onward. No SLOT_CCAP1/SLOT_CCAP2 in schema. | **CRITICAL** |
| T-W3-4 | indload.c:44–46 (UIC flux seed) | — | UIC IC path entirely absent — no `IC1`/`IC2` params, no MODEUIC branch. Transformer with non-zero initial winding currents cannot be UIC-initialised | HIGH |
| T-W3-5 | indload.c:41, 107 (`m = INDm`) | — | Parallel-multiplicity factor absent — no `M` param | MEDIUM |
| T-W3-6 | indload.c:114–116 (SLOT_VOLT1/2 s1←s0 on MODEINITTRAN) | — | no SLOT_VOLT slots; volt-state history copy absent | LOW |

### tapped-transformer

**F4 classification:** F4a per architectural-alignment.md §F4a (coupled inductors with tap — FIX).

| # | ngspice ref:line | digiTS ref:line | Divergence | Severity |
|---|---|---|---|---|
| TT-W3-1 | — (compiler) | tapped-transformer.ts:683 `branchCount:1` | **Same `branchCount:1` bug as transformer — needs 3.** Branch index collision in every center-tap circuit. | **CRITICAL** |
| TT-W3-2 | indload.c flux + mutual | tapped-transformer.ts:391–403 | MODEINITTRAN s1←s0 copy happens *before* flux write + NIintegrate; ngspice does it *after*. Ordering inverted. | HIGH |
| TT-W3-3 | indload.c (non-DC gate) | tapped-transformer.ts:407 | Gate is `MODETRAN` not `!MODEDC` — same bug as transformer T-W3-2 | MEDIUM |
| TT-W3-4 | indload.c:114–116 | — | No SLOT_VOLT1/2/3 slots; voltage state not copied at MODEINITTRAN | LOW |
| TT-W3-5 | — | tapped-transformer.ts (combined flux formula) | Three-winding flux `phi1 = L1·i1 + M12·i2 + M13·i3` computed in one expression; ngspice uses two-pass (self-loop + mutual-loop). Functionally equivalent for self-contained element; structural departure from F4a constraint §1 | LOW |
| TT-W3-6 | — | tapped-transformer.ts:254 (class-body `setParam` no-op, overridden by closure) | Latent `setParam` hot-reload hazard if constructor is called directly instead of via `buildTappedTransformerElement` | LOW |

### bjt (L0 + L1)

**Coverage:** full `BJTload` vs `bjt.ts::load()` (L0 + L1).

| # | ngspice ref:line | digiTS ref:line | Divergence | Severity |
|---|---|---|---|---|
| B-W3-1 | bjtload.c:583–585 | bjt.ts:1456 | `czsub = tp.tSubcap * BJTareac` missing — substrate cap off by factor AREA for AREA≠1 | **CRITICAL** |
| B-W3-2 | bjtload.c:488 (`MIN(MAX_EXP_ARG, vsub/vts)` clamp) | bjt.ts:1368 | `evsub = Math.exp(vsubLimited/vts)` unclamped — overflow reachable via MODEINITSMSIG/MODEINITTRAN seeding paths that bypass pnjlim | HIGH |
| B-W3-3 | bjtload.c:525 (no `delta>0` guard) | bjt.ts:1385 | Extra `ctx.delta > 0` guard on excess-phase — D3 narrowed to MODETRAN\|MODEAC path; Phase 5.2.10 owns | MEDIUM → plan-addendum 5.2.10 |
| B-W3-4 | bjtload.c:749 (noncon gate INITFIX+OFF) | bjt.ts:871 (L0), 1321 (L1) | Unconditional `noncon.value++` on icheckLimited; Phase 5.1.4/5.2.4 own | MEDIUM → plan-addendum 5.1.4, 5.2.4 |
| B-W3-5 | bjtload.c:780 (BJTgx write) | bjt.ts L0 schema | `BJT_SIMPLE_SCHEMA` has no GX slot; bypass-path read of state0[GX] would be undefined | LOW |

**Cross-ref absorbed:** bypass block, MODEINITPRED xfact, vbxRaw seeding, L1 MODEINITSMSIG return correctness, AREAB/AREAC params — all verified or routed to Phase 5 rows.

### mosfet

**Coverage:** full `MOS1load` vs `mosfet.ts::load()`.

| # | ngspice ref:line | digiTS ref:line | Divergence | Severity |
|---|---|---|---|---|
| M-W3-1 | mos1load.c:385 (`!CKTfixLimit` guard) | mosfet.ts:1132 | Reverse-mode `limvds(-vds, ...)` called unconditionally; missing `!ctx.cktFixLimit` guard | HIGH |
| M-W3-2 | mos1load.c:108 (`Check=1` at instance loop top) | mosfet.ts:976 (`let icheckLimited=false` closure init) | `icheckLimited` never reset to true per-call — stale value persists across load() invocations; MODEINITJCT path exempts noncon bump that ngspice doesn't exempt | HIGH |
| M-W3-3 | mos1load.c (no MODEINITSMSIG limiting skip) | mosfet.ts:1092 | digiTS skips fetlim+limvds for MODEINITSMSIG; ngspice applies limiting during SMSIG (no such exemption) | HIGH |
| M-W3-4 | mos1load.c:507 (`model->MOS1gamma` = tGamma) | mosfet.ts:1255 | `von = tp.tVbi * polarity + params.GAMMA * sarg` — `params.GAMMA` raw, not temperature-corrected. Needs `tp.tGamma`; verify `computeTempParams` produces it | MEDIUM |
| M-W3-5 | mos1load.c:875–877 (zero-outs in `else` branch) | mosfet.ts:1463–1466 | CQGS/CQGD/CQGB zero-outs placed in `initOrNoTran` branch instead of MODETRAN `else` — harmless when cap=0 but stale slot on nonzero cap + MODEINITTRAN | MEDIUM |
| M-W3-6 | mos1load.c:739–743 (noncon gate) | mosfet.ts:1624 | `noncon.value++` ungated; ngspice gates `off==0 \|\| !(MODEINITFIX\|MODEINITSMSIG)` | MEDIUM |

**D-8 canary:** INCONCLUSIVE from static analysis. Invented SLOT_CAP_IEQ_DB that held the -3.5e-12 value is gone; quantity now embedded in `niIntegrate` output at mosfet.ts:1340–1388. Resolution requires post-A1 harness comparison.

**G1 sign convention:** CLEAN — all `vbs`/`vbd` references consistent post-W1.3.

**Cross-ref absorbed:** predictor xfact, MODEINITSMSIG body, MODEINITJCT IC params, bypass, cktFixLimit plumbing, noncon gate broader scope, qgs/qgd/qgb xfact, per-instance `vt`, MODEINITFIX+OFF, companion zero-fix — routed to Phase 6 rows.

### jfet (NJFET + PJFET)

**fet-base.ts:** CONFIRMED DELETED — zero functional references in src/.

| # | ngspice ref:line | digiTS ref:line | Divergence | Severity |
|---|---|---|---|---|
| J-W3-1 | jfetload.c:463–466 (`continue` skips stamps under MODEINITSMSIG) | njfet.ts:677–680, pjfet.ts:636–639 | No `return` after `s0[SLOT_QGS]/[SLOT_QGD]` writes in MODEINITSMSIG — state-write block and stamps always execute. ngspice skips them entirely. | **CRITICAL** |
| J-W3-2 | jfetload.c:498–508 (noncon gate) | njfet.ts:742–743, pjfet.ts:698–699 | Outer gate missing entirely — no `if (!(MODEINITFIX) \| !(MODEUIC))` wrapper on noncon bump | HIGH |
| J-W3-3 | jfetload.c:536–539 (external RD/RS stamps) | njfet.ts:768–776, pjfet.ts:721–730 | `gdpr`/`gspr` computed but never stamped. When `RD>0` or `RS>0`, ohmic series resistances silently dropped | HIGH |

**A-1/A-2:** CONFIRMED SATISFIED — no `Math.min(expArg, 80)` clamps anywhere in njfet.ts or pjfet.ts.

**Cross-ref absorbed:** bypass block + `cghat`/`cdhat` convergence, MODEINITPRED state-copy of CG/CD/CGD/GM/GDS/GGS/GGD, JFET-specific `checkConvergence` — routed to Phase 7 rows.

---

## §2. F4c papering residue (L1c)

CLEAN (7 devices): triac (E-1 papering confirmed removed), scr, diac, tunnel-diode, triode, memristor, analog-fuse.

F4b APPROVED FIX (not F4c) — confirmed by architectural-alignment.md, audits kept clean: crystal, LED.

F4a APPROVED FIX (not F4c) — confirmed, audit kept clean: transmission-line.

**RESIDUE (2 devices):**

| # | file:line | Residue |
|---|---|---|
| F4c-W3-1 | ntc-thermistor.ts:20 | Comment `"Unified load() pipeline (matches ngspice DEVload)"` — F4c devices may not frame themselves as ngspice ports |
| F4c-W3-2 | ntc-thermistor.test.ts:328, 362, 364 | Comments `"NGSPICE reference: ngspice resload.c..."` + variable `NGSPICE_G_REF = 1 / NTC_DEFAULTS.r0` — test uses ngspice as parity baseline for F4c device |
| F4c-W3-3 | spark-gap.ts:29 | Comment `"Unified load() pipeline (matches ngspice DEVload)"` — same pattern as F4c-W3-1 |
| F4c-W3-4 | spark-gap.test.ts:375, 407, 418, 422, 426, 429, 432 | `"NGSPICE reference: ngspice resload.c..."` + `NGSPICE_G_REF` variable + assertions against it |

**Remedy for all F4c-W3-*:** strip the comments, rename `NGSPICE_G_REF` to `EXPECTED_G` (or similar non-ngspice name), remove citations. F4c devices are digiTS-only; their tests are self-compare, not ngspice-parity.

---

## §3. Suppression residue (L3)

**Status:** L3 agent returned `completed` but the output text is truncated mid-analysis (final table not produced). Re-spawn or SendMessage required to get the concrete site-by-site residue list.

**Partial signal:** agent confirmed `W2.4 has already executed most of the backlog work` before output cutoff. Residue count unknown; likely low based on partial traversal. Follow-up lane needed before Phase 3+ begins.

---

## §4. Deleted-test manifest (L2, proposal)

**DEFINITE-DELETE files:** 0.

**Already A1-compliant (file headers document W2.4 deletions):**
- `src/components/semiconductors/__tests__/bjt.test.ts`
- `src/components/semiconductors/__tests__/jfet.test.ts`
- `src/components/active/__tests__/timer-555.test.ts`

**PARTIAL block deletions proposed (user review before execution):**

| File | Lines | Reason |
|---|---|---|
| `polarized-cap.test.ts` | 492–494, 661–662 | `pool.state0[0/1/2]` and `SLOT_GEQ_PC`/`SLOT_IEQ_PC` assertions — A1-deleted cross-method slots |
| `capacitor.test.ts` | 569 | `expect(q0_actual).toBe(1e-12)` — hand-computed with no ngspice provenance |
| `crystal.test.ts` | 2× pool state0 assertions | Hand-computed SLOT reads |

**Kept with NGSPICE_* provenance (21 files):** `diode.test.ts`, `resistor.test.ts`, bjt-backed tests, etc. — all carry `// from ngspice harness run <cite>` or equivalent.

**Total `toBeCloseTo` / `toBe(<number>)` occurrences:** 85 files. Most are parameter plumbing, F4c self-compare, or have provenance. No bulk sweep required.

**Execute only after user review.** Separate commit: `Phase 2.5 W3 L2 — stale test deletion per user-approved list`.

---

## §5. Carry-forwards from reconciliation-notes.md §5

Seven items deferred to post-A1 from reconciliation:

| Item | Pre-W3 status | W3 verification |
|---|---|---|
| A-1 | `Math.min(expArg, 80)` absence in JFET | CONFIRMED ABSENT (jfet audit §W3 J section) |
| A-2 | `Math.exp(80)` absence in JFET | CONFIRMED ABSENT (same) |
| C-4 | digital-pin behavioral cache never primed | Not audited in W3 (scope: behavioral, not ngspice-parity). **Carry as open PARITY item into Phase 3+.** |
| C-5 | [to be looked up from reconciliation-notes.md] | Not in W3 scope — **carry open** |
| D-1 | `Math.min(vd/nVt, 700)` / `Math.exp(700)` in diode | CONFIRMED ABSENT (D-W3 section) |
| D-8 | MOSFET cgs_cgd +0 vs -3.5e-12 | INCONCLUSIVE — slot that held value is gone; needs harness re-measurement post-Phase 6 |
| D-15 | capacitor `_IC = 0.0` default + unconditional cond1 | CONFIRMED SATISFIED (capacitor audit) |

Four of seven resolved. D-8 carries forward as post-Phase-6 harness measurement. C-4 / C-5 carry forward as PARITY items independent of A1.

---

## §6. Summary counts and handoff

### CRITICAL (11):
- D-W3-1, D-W3-2 (diode IKF/IKR formula + current-not-corrected, two regions)
- Z-W3-1, Z-W3-2 (zener missing three-region structure + reverse-cubic branch)
- PC-W3-1 (polarized-cap missing entire `dio/*` reverse-bias clamp — half of F4b composition)
- I-W3-1 (inductor uses `voltages[b]` not `rhsOld[b]` for flux seeding — explains rl_dc_steady_state failure)
- T-W3-1, T-W3-2, T-W3-3 (transformer `branchCount:1` bug + wrong integration gate + manual ag-expansion skips NIintegrate)
- TT-W3-1 (tapped-transformer same branchCount bug, needs 3)
- B-W3-1 (BJT `czsub` missing AREA factor)
- J-W3-1 (JFET MODEINITSMSIG missing `return` — stamps always execute)
- C-W3-1 (architectural: verify `solver.stampElement` is additive)

### HIGH (14):
- Z-W3-3, Z-W3-4 (zener gmin Norton-form, MODEINITJCT dispatch)
- PC-W3-2, PC-W3-3, PC-W3-4 (polarized-cap MODEAC gate + inner fork + missing parity test)
- I-W3-2 (inductor spurious MODEDC|MODEINITJCT arm)
- T-W3-4 (transformer UIC path absent)
- B-W3-2 (BJT `evsub` unclamped)
- M-W3-1, M-W3-2, M-W3-3 (MOSFET cktFixLimit guard, icheckLimited init, MODEINITSMSIG limiting skip)
- J-W3-2, J-W3-3 (JFET noncon gate absent, RD/RS stamps dropped)
- Z-W3-5 → plan-addendum 4.3.3

### MEDIUM / LOW: 26 findings, all tabulated per device above.

### Phase-routing:
- **Direct W3 fix commit** (post-review): CRITICAL + HIGH items above not enumerated in plan-addendum.
- **Phase 3+**: items cross-referenced to plan-addendum Phase 3/4/5/6/7 rows.
- **Architectural (§I2 notes)**: CCAP lifetime for diode, inductor — user action per forcing function.
- **F4c residue**: fix in a dedicated small commit before Phase 3 begins.

### Handoff

Next document: **`spec/phase-3-onwards.md`**. Re-authors surviving plan.md Phases 3–9 tasks against the post-A1 `load()` file layout + the W3 findings above. Inputs: this file, `spec/plan-addendum.md`, `spec/architectural-alignment.md`.

Remaining blockers before Phase 2.5 is declared complete:
1. User review of CRITICAL items (decide fix-now vs. defer-to-Phase-3+).
2. L3 re-spawn for complete suppression residue table.
3. L2 execution commit after user approves the PARTIAL deletion list.
4. Commit this file as W3 consolidation.
