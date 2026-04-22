# Plan Addendum — Reconciliation of `plan.md` against Track A

**Date:** 2026-04-21
**Source:** `spec/architectural-alignment.md` (30 items, all APPROVED 2026-04-21)
**Reconciled:** `spec/plan.md` Phases 2–9 (Phases 0–1 complete and out of scope)
**Output status:** Addendum — supersedes the corresponding plan.md task text where verdicts differ.

## Purpose

`plan.md` was authored before Track A approval. Many tasks operate on architecture that Track A restructures — principally the `_updateOp`/`_stampCompanion` split (A1), the `pool.uic` / `statePool.analysisMode` / `poolBackedElements` cleanup (A2–A4), solver atomicity (B1–B5), control-flow collapse (C1–C3), init-mode dispatch (D1–D4), device-parity subgroup verdicts (F2, F4a/b/c), MOSFET sign convention (G1), limiting ownership (H1–H2), and the stricter no-suppression policy (I1).

Each remaining task in `plan.md` Phases 2–9 is tagged against one of four verdicts below.

## Verdict definitions

- **CARRY AS-IS** — task text stands unchanged. Still correct against the Track-A-approved architecture.
- **SATISFIED-BY &lt;Track A ID&gt;** — task is subsumed by an APPROVED Track A item. Remove from plan; Track A execution handles it.
- **PAUSE-UNTIL-A1** — task structurally depends on the `_updateOp`/`_stampCompanion` split. The task itself cannot meaningfully exist until A1's `load()` structure exists (e.g., "move xfact extrapolation inside load()" cannot be authored as a plan until `load()` exists). Frozen until A1 lands; needs re-authoring after.
- **REWRITE POST-A1** — task intent is still valid but the specific surgery (line numbers, method names, cap/IEQ slot references, block locations) will be meaningless after A1. Re-author against the post-A1 `load()` structure when A1 lands; drop the line/block-specific instructions.

## Phase-by-phase mapping

### Phase 2 — F3 + F4 (cktMode bitfield + LoadContext migration) — IN FLIGHT

#### Wave 2.1 — Foundation (F3/F4 shared prerequisites)

| Task | Verdict | Route / note |
|---|---|---|
| 2.1.1 Create `ckt-mode.ts` with 14 `MODE*` constants + helpers | SATISFIED-BY C2 + C3 | C2 mandates direct `cktMode` assignment; C3 drops `iteration` from `cktLoad`. Both require the bitfield/helpers this wave creates. |
| 2.1.2 Migrate `LoadContext`: remove `InitMode`/`iteration`/`isDcOp`/`isTransient`/`isTransientDcop`/`isAc`; add `cktMode: number` | SATISFIED-BY A2 + A3 + C3 | A3 deletes `statePool.analysisMode` string; A2 deletes `pool.uic`; C3 deletes the iteration param. The LoadContext collapse is the exact remedy Track A prescribes. |
| 2.1.3 Add `cktMode: number` to `CKTCircuitContext`; mark legacy mirrors `@deprecated` | SATISFIED-BY A3 | A3 deletes the string field; the `@deprecated` mirrors disappear with it. |
| 2.1.4 Collapse `ctx.noncon` dual-storage to accessor; add `troubleNode: number \| null` | SATISFIED-BY A4 | A4 cleanup on the same pool object. Dual-storage is the defensive resync pattern A4 removes. |

#### Wave 2.2 — `cktLoad` rewrite

| Task | Verdict | Route / note |
|---|---|---|
| 2.2.1 Rewrite `cktLoad` gating: drop `iteration`, mirror `cktMode`, nodeset gate, IC gate, null-guard, remove duplicate noncon reset | SATISFIED-BY C3 | C3 is exactly this rewrite. Already substantially landed per plan.md status. |

#### Wave 2.3 — Engine rewrite (F3 D1–D5)

| Task | Verdict | Route / note |
|---|---|---|
| 2.3.1 Rewrite `dcopFinalize` to single `cktLoad(ctx)` after `setInitf(cktMode, MODEINITSMSIG)`; no save/restore dance | SATISFIED-BY C1 + I1 | C1 replaces the NR pass with a direct `cktLoad`; I1 mandates removing the save/restore dance. |
| 2.3.2 Gate all three `dcopFinalize` call sites on `!ctx.isTransientDcop` | SATISFIED-BY C1 | Call-site gating is part of the C1 rewrite scope. |
| 2.3.3 Rewrite `_seedFromDcop` as three-statement `dctran.c:346-350` port | SATISFIED-BY C2 | C2 mandates direct `cktMode` assignment at the DCop→transient transition, inside `_seedFromDcop`. |
| 2.3.4 Delete `_firsttime` field + 9 read/write sites + `firstNrForThisStep` + `"transient"` sentinel | SATISFIED-BY C2 | C2 deletes `_firsttime` explicitly. |
| 2.3.5 Remove `ctx.isTransient = false` in `runNR`; derive mirrors from cktMode | SATISFIED-BY A3 + C2 | A3 removes the duplicated field; C2 collapses the mode-write path. |
| 2.3.6 Caller-side cktMode writes: `_transientDcop` / `dcOperatingPoint`; `srcFact` default to 1 | SATISFIED-BY C2 | Direct `cktMode` writes at the transition points are the C2 pattern. |
| 2.3.7 Convert B8 initMode writes at ~10 sites to `setInitf()` + mirror | SATISFIED-BY A3 + C2 | Every site drops the string write in favour of `setInitf()` on the bitfield. |
| 2.3.8 Fix `newtonRaphson` UIC early-exit to gate on `isTranOp(cktMode) && isUic(cktMode)` | SATISFIED-BY A2 + C2 | A2 deletes `pool.uic`; the gate switches to `cktMode & MODEUIC`. |

#### Wave 2.4 — Device-load migration (F4 Wave 3)

| Task | Verdict | Route / note |
|---|---|---|
| 2.4.1 Diode MODEINITSMSIG + bitfield (state0/state1 seeding, cap-gate, store-back under INITSMSIG) | REWRITE POST-A1 | D2 ports the MODEINITSMSIG branch verbatim into `load()`. Current line-numbered surgery against split compute/stamp is meaningless once A1 collapses them. |
| 2.4.2 BJT (L0+L1) MODEINITSMSIG + bitfield: vbe/vbc seeding; charge-block gate; small-signal store-back | REWRITE POST-A1 | D3 removes the `dt > 0` gate; the surrounding surgery targets split-architecture line locations that A1 deletes. |
| 2.4.3 MOSFET MODEINITSMSIG + cktMode state: rename `_ctxInitMode`→`_ctxCktMode`; 9 rewrite sites | REWRITE POST-A1 | Line-specific rewrite against split-method structure. A1 collapses into `load()`; the 9 sites become one contiguous block. |
| 2.4.4 JFET n-/p-channel MODEINITSMSIG + bitfield | REWRITE POST-A1 | Same pattern as 2.4.1–2.4.3. |
| 2.4.5 Capacitor gate fix (drop MODEDCOP from participation gate; INITPRED/INITTRAN bitfield) | CARRY AS-IS | Passive device, no `_updateOp`/`_stampCompanion` split entanglement. Bitfield read change is independent of A1. |
| 2.4.6 Inductor bitfield migration (`!(MODEDC\|MODEINITPRED)` flux gate; `!MODEDC` integrate gate) | CARRY AS-IS | Same rationale as 2.4.5. |
| 2.4.7 Remaining charge/reactive devices (zener, varactor, scr, tunnel-diode, polarized-cap, transformer, tapped-transformer, transmission-line, crystal, real-opamp, led) | REWRITE POST-A1 | Mixed bag. Varactor is also SATISFIED-BY F2 (folds into diode). F4c devices (scr, tunnel-diode, real-opamp) retain self-compare labelling per F4c ACCEPT. The bitfield rewrite surgery still needs post-A1 re-authoring against `load()`. |
| 2.4.8 Shared solver helpers: `fet-base.ts` capGate; `behavioral-remaining.ts`, `bridge-adapter.ts`, `digital-pin-model.ts`; `harness/capture.ts:294` | REWRITE POST-A1 | `fet-base.ts` capGate is structurally tied to MOSFET `load()`. `bridge-adapter`/`digital-pin-model` are E3 ACCEPT surfaces — bitfield rewrite still applies but the exact edit changes after A1. |
| 2.4.9 `checkConvergence` A7 fix: OFF + (`MODEINITFIX\|MODEINITSMSIG`) short-circuit across diode/bjt/mosfet | REWRITE POST-A1 | Convergence check for diode/bjt/mosfet lives inside the method-split that A1 collapses. |

#### Wave 2.5 — Test migration

| Task | Verdict | Route / note |
|---|---|---|
| 2.5.1 Strip `iteration:` from LoadContext literals; rewrite `isDcOp`/`initMode` assignments to `cktMode = MODEDCOP \| MODEINITFLOAT` | SATISFIED-BY A3 + C3 | Mechanical rewrite falls out of the field deletions. Any test encoding a hand-computed expected value on an A1-deleted slot is subject to deletion per A1 test-handling rule. |
| 2.5.2 Audit behavioral elements for accept() dependency; seed `_prevClockVoltage` from `initState` | CARRY AS-IS | Behavioral-digital layer is E2 ACCEPT; no ngspice-parity entanglement. Independent of A1. |

### Phase 2.5 — Track A execution (NEW — inserted here)

Not part of the original plan. Executes the full Track A umbrella as a single atomic push:

- A1 collapse `_updateOp`/`_stampCompanion` → single `load()` per device (umbrella, every analog device)
- A2 delete `pool.uic`
- A3 delete `statePool.analysisMode`
- A4 delete `poolBackedElements` + `refreshElementRefs`
- F2 varactor → diode instantiation
- F4a (11 devices with direct ngspice primitive) ngspice-source-aligned
- F4b (4 composite devices) compose-to-primitive
- F4c (15 digiTS-only devices) labelled self-compare; excluded from parity harness
- G1 MOSFET VSB/VBD → VBS/VBD sign convention
- H1 `limitingCollector` sync inside cktLoad
- H2 `addDiagonalGmin` ownership into solver
- I1 enumerate + remove suppression patterns (save/restore pairs, silent catches, "spurious"/"expected" gates)

Harness-infrastructure sync is handled by the `W1.9 — device-mappings.ts schema sync` lane at the end of the W1 block (see `spec/phase-2.5-execution.md §4 W1.9`). W1.9 is not a Track A item; it is the terminal W1 lane that resolves slot-name drift accumulated by the per-device W1.1–W1.8 lanes so the harness slot-correspondence table matches the post-port schemas.

See `spec/architectural-alignment.md` for the authoritative task list. Test-handling rule per A1: per-component tests whose expected values were hand-computed and inspect A1-deleted slots are deleted during execution (not fixed). Parameter plumbing / F4c self-compare / interface-contract tests survive, clearly labelled.

### Phase 3 — F2 (NR reorder gate + per-device initPred predictor)

#### Wave 3.1 — NR reorder timing

| Task | Verdict | Route / note |
|---|---|---|
| 3.1.1 Pre-factor `NISHOULDREORDER` gate at `newton-raphson.ts:285-303`, gated on `initMode==="initJct"` or `(initMode==="initTran" && iteration===0)` using cktMode helpers | CARRY AS-IS | B5 approved; this wave is the execution. Re-word the gate to read `cktMode` helpers (already required post-Phase-2). |
| 3.1.2 `INITF` dispatcher: add ngspice cross-reference comments to `forceReorder()` calls | CARRY AS-IS | Comment-only; no A1 entanglement. |

#### Wave 3.2 — Device initPred xfact extrapolation

| Task | Verdict | Route / note |
|---|---|---|
| 3.2.1 Diode xfact `else if (initMode==="initPred")` branch: `vdRaw = (1+xfact)*s1[VD] - xfact*s2[VD]` | PAUSE-UNTIL-A1 | xfact extrapolation lives inside `load()` post-A1. The "branch at diode.ts:464-490" instruction is pre-A1 surgery; re-authored against unified `load()` structure. |
| 3.2.2 BJT behavioral xfact: same pattern for `vbeRaw`/`vbcRaw` | PAUSE-UNTIL-A1 | Same rationale. BJT L0 `load()` is A1's deliverable. |
| 3.2.3 BJT L1 xfact: `vbeRaw`/`vbcRaw` + `vsubRaw` per `bjtload.c:302-305` | PAUSE-UNTIL-A1 | Same rationale. BJT L1 `load()` post-A1. |
| 3.2.4 BJT L1 missing state-copy slots: `s0[RB_EFF]=s1[RB_EFF]`, `s0[VSUB]=s1[VSUB]` | PAUSE-UNTIL-A1 | Inside BJT L1 `load()` — cannot be written until the unified `load()` exists. |
| 3.2.5 xfact scope audit: grep `.xfact` across device files; confirm none outside `initMode==="initPred"` guard | REWRITE POST-A1 | Audit text references `initMode==="initPred"` string; post-A1 that switches to `cktMode & MODEINITPRED`. Keep the audit; re-word the guard form. |

#### Wave 3.3 — Additional divergences

| Task | Verdict | Route / note |
|---|---|---|
| 3.3.1 Unconditional initTran set on first step: move the initTran assignment outside `if (statePool)` | SATISFIED-BY C2 | C2 is the three-statement `dctran.c:346-350` port inside `_seedFromDcop`; the unconditional initTran set is exactly that port. |
| 3.3.2 NIDIDPREORDER lifecycle audit: compare `invalidateTopology()` call sites vs. ngspice `NIreinit()` | SATISFIED-BY B4 | B4 is the full invalidateTopology trigger-parity audit. Supersedes. |

### Phase 4 — F5 (Voltage Limiting Primitives + Shared LoadContext Extensions)

#### Wave 4.1 — Shared LoadContext extensions

| Task | Verdict | Route / note |
|---|---|---|
| 4.1.1 Add `limitingCollector: LimitingEvent[] \| null` to `LoadContext` + import type | SATISFIED-BY H1 | H1 wires the collector end-to-end; the field declaration is part of H1 scope. |
| 4.1.2 Add F-BJT-required fields: `bypass`, `voltTol`, `gmin`, `deltaOld`, `trouble` | PAUSE-UNTIL-A1 | These fields exist to carry values between split compute/stamp methods inside BJT. Under A1's unified `load()` the majority become locals; only `gmin` and `bypass` are genuine context fields. Re-authored post-A1 with a narrower field list. |
| 4.1.3 Add F-MOS-required `cktFixLimit: boolean` to `LoadContext` and `CKTCircuitContext` | CARRY AS-IS | Genuine global context field; survives A1 collapse unchanged. |
| 4.1.4 Sync all new fields into `loadCtx` per-iteration inside `cktLoad` | SATISFIED-BY H1 | H1 is the cktLoad sync wiring. |

#### Wave 4.2 — Core primitive rewrites

| Task | Verdict | Route / note |
|---|---|---|
| 4.2.1 D1: Rewrite `pnjlim` verbatim `devsup.c:49-84` translation including Gillespie negative-bias branch | SATISFIED-BY D4 | D4 is the Gillespie-branch port. Verbatim `devsup.c:49-84` is the D4 prescription. |
| 4.2.2 D2: Rewrite `fetlim`; fix `vtstlo` coefficient to `Math.abs(vold - vto) + 1` matching `devsup.c:102` | CARRY AS-IS | Not covered by a Track A item; genuine numerical primitive fix. Passes I1 (no suppression). |
| 4.2.3 D3: `limvds` parity audit — verified identical, no diff | CARRY AS-IS | Pure comment/verification; no A1 dependency. |
| 4.2.4 F5-J: Doc-comment citation refresh (`devsup.c:50-58` → `49-84`) | CARRY AS-IS | Citation hygiene per I2 policy. |

#### Wave 4.3 — Call-site fixes

| Task | Verdict | Route / note |
|---|---|---|
| 4.3.1 Sync `ctx.loadCtx.limitingCollector = ctx.limitingCollector` in `cktLoad` | SATISFIED-BY H1 | Exactly H1's cktLoad wiring. |
| 4.3.2 F5-B + F5-C: LED initJct skip branch + `ctx.limitingCollector?.push(...)` | REWRITE POST-A1 | LED is an A1-affected device (copies diode `SLOT_CAP_GEQ`/`_IEQ`). The collector push moves inside unified `load()`. |
| 4.3.3 F5-F: Zener — swap `params.BV` for temperature-scaled `tBV` in breakdown branch | REWRITE POST-A1 | Zener is F4a FIX (ngspice `dio/*` with breakdown params). The edit re-targets against post-A1 zener `load()`. |
| 4.3.4 F5-G + F5-H: BJT substrate audit — document simple-model divergence; verify L1 `pnjlim(vsubRaw, ..., tp.tSubVcrit)` | REWRITE POST-A1 | BJT L1 audit line references (1483-1487) are pre-A1. Audit survives; line references re-authored post-A1. |

### Phase 5 — F-BJT (BJT L0 + L1 Full Alignment)

Every task in this phase operates on the BJT `_updateOp` / `_stampCompanion` split or on the 7 invented L1 cap/ieq slots that A1 deletes. All are PAUSE-UNTIL-A1 or REWRITE POST-A1.

#### Wave 5.1 — Simple model (spice-l0) alignment

| Task | Verdict | Route / note |
|---|---|---|
| 5.1.1 A1: initPred xfact extrapolation + full state1→state0 copy; route predicted values into pnjlim skip path | PAUSE-UNTIL-A1 | Cannot be authored before the unified BJT `load()` exists. |
| 5.1.2 A3: MODEINITJCT priming — 3-branch ngspice priority (UIC / off==0 / zero) | PAUSE-UNTIL-A1 | Priming block is inside `load()` post-A1. |
| 5.1.3 A4: NOBYPASS bypass test — 4-tolerance delvbe/delvbc/cchat/cbhat; gate computeBjtOp on !bypassed | PAUSE-UNTIL-A1 | Bypass test wraps the entire `load()` early-exit path. Requires `load()` structure. |
| 5.1.4 A5: noncon gate INITFIX/off exception | REWRITE POST-A1 | Small edit; re-targeted against unified `load()`. |
| 5.1.5 A8: Parameterize NE/NC — add to `BJT_PARAM_DEFS`, plumb through factory + `makeTp` | CARRY AS-IS | Parameter plumbing; orthogonal to A1. Survives A1 verbatim. |
| 5.1.6 A2/A9: MODEINITSMSIG + MODEINITTRAN stubs | PAUSE-UNTIL-A1 | Mode-dispatch branches inside `load()`. |

#### Wave 5.2 — SPICE-L1 alignment

| Task | Verdict | Route / note |
|---|---|---|
| 5.2.1 B1/B2: initPred xfact + VSUB/GX/RB_EFF copy; route predicted voltages, skip pnjlim under initPred | PAUSE-UNTIL-A1 | Same rationale as 5.1.1. |
| 5.2.2 B3: MODEINITSMSIG block — evaluate OP, write `cexbc=geqcb`, return (skip stamps) | PAUSE-UNTIL-A1 | Early-return inside `load()`. |
| 5.2.3 B4: NOBYPASS bypass test — 4-tolerance gate; reload state0 on bypass | PAUSE-UNTIL-A1 | Same as 5.1.3. |
| 5.2.4 B5: noncon gate INITFIX/off | REWRITE POST-A1 | Small edit against unified `load()`. |
| 5.2.5 B8: Fix CdBE to use `op.gbe` (not `op.gm`) in diffusion cap | REWRITE POST-A1 | Operates on A1-deleted `L1_SLOT_CAP_GEQ_BE` / `_IEQ_BE` cross-method slots. Diffusion cap becomes a local in unified `load()`. |
| 5.2.6 B9: External BC cap node destination: `nodeC_ext` → `nodeC_int` at 4 stamp sites | REWRITE POST-A1 | Stamp-site line numbers change under A1. |
| 5.2.7 B10: Add BJTsubs (SUBS) model param; plumb through defs, factory, subs derivation | CARRY AS-IS | Parameter plumbing; orthogonal to A1. |
| 5.2.8 B11: Add AREAB/AREAC params — area scaling for c4, czsub, czbc | CARRY AS-IS | Parameter plumbing; orthogonal to A1. |
| 5.2.9 B12: MODEINITTRAN `cqbe`/`cqbc`/`cqbx`/`cqsub` bcopy to s1 | REWRITE POST-A1 | State-copy block inside A1 `load()`. Slots survive (real charges) but location moves. |
| 5.2.10 B15: `cexbc` state1/state2 seed on INITTRAN; split shift-history gate on `prevDt > 0` | REWRITE POST-A1 | Inside `load()` post-A1. |
| 5.2.11 B22: Excess-phase `cex` uses raw `opIf` not `cbe_mod` | REWRITE POST-A1 | Inside `load()` post-A1. |
| 5.2.12 F-BJT-ADD-21: XTF=0 gbe adjustment — run `gbe`/`cbe` mod regardless of XTF when TF>0 && vbe>0 | REWRITE POST-A1 | Inside `load()` post-A1. |
| 5.2.13 F-BJT-ADD-23: `geqsub=gcsub+gdsub` aggregation — single Norton stamp | REWRITE POST-A1 | Operates on A1-deleted `_IEQ_BC_EXT` / `_CS` slots. Norton stamp becomes a local in `load()`. |
| 5.2.14 F-BJT-ADD-25: cap gating for initSmsig / UIC-DC-OP | REWRITE POST-A1 | Gate inside `load()`. |
| 5.2.15 F-BJT-ADD-34: VSUB limiting collector entry | REWRITE POST-A1 | Collector push inside `load()`; SATISFIED-BY H1 for the sync side. |

### Phase 6 — F-MOS (MOSFET MOS1 Alignment)

Every task operates on MOSFET `_updateOp` / `_stampCompanion` split or on the 11 invented cap/ieq/Q slots that A1 deletes.

#### Wave 6.1 — Infrastructure

| Task | Verdict | Route / note |
|---|---|---|
| 6.1.1 B-5: SLOT_VON zero-init — change from `NaN` to `{kind:"zero"}`; drop `isNaN` guard | REWRITE POST-A1 | Slot lifecycle; survives A1 (VON is real state) but init location shifts. |
| 6.1.2 B-4: Extend LTE to bulk charges — add qbs, qbd to MOSFET `getLteTimestep` loop | CARRY AS-IS | LTE hook is orthogonal to A1. Bulk charges are real state slots. |

#### Wave 6.2 — MOSFET correctness

| Task | Verdict | Route / note |
|---|---|---|
| 6.2.1 M-1: Predictor xfact extrapolation (**CRITICAL**) — replace broken state-copy stub with full `mos1load.c:205-227` xfact formula | PAUSE-UNTIL-A1 | Predictor lives inside unified `load()` post-A1. |
| 6.2.2 M-2: MODEINITSMSIG path + Meyer averaging fix | PAUSE-UNTIL-A1 | SMSIG branch inside `load()`. |
| 6.2.3 M-3: MODEINITJCT IC_VDS/VGS/VBS — add params; rewrite `primeJunctions` | REWRITE POST-A1 | Parameter add (CARRY-AS-IS part) plus primeJunctions rewrite (inside `load()` post-A1). |
| 6.2.4 M-4: Bypass test — NOBYPASS-gated bypass block after node-voltage read | PAUSE-UNTIL-A1 | Wraps `load()` early-exit; requires unified `load()`. |
| 6.2.5 M-5: `CKTfixLimit` gate on reverse `limvds` — thread `cktFixLimit` through `limitVoltages()` | REWRITE POST-A1 | `limitVoltages` is inside `load()` post-A1. The `cktFixLimit` plumbing itself carries. |
| 6.2.6 M-6: icheck noncon gate — suppress `ctx.noncon++` when `off && (initFix\|\|initSmsig)` | REWRITE POST-A1 | Small edit inside `load()` post-A1. |
| 6.2.7 M-7: qgs/qgd/qgb xfact extrapolation | REWRITE POST-A1 | Operates on A1-deleted `SLOT_Q_GS/_GD/_GB/_DB/_SB` transfer slots. Charges become locals in `load()`. |
| 6.2.8 M-8: `von` formula comment — add justification; no code change | CARRY AS-IS | Comment-only. |
| 6.2.9 M-9: Per-instance `vt` — replace hardcoded `VT` with `REFTEMP*KoverQ` in bulk-diode `exp(vbs/vt)` paths | REWRITE POST-A1 | Line refs (1418-1436, 1266-1284) move under A1. Edit re-authored. Note: also touches G1 sign-convention surface (vbs). |
| 6.2.10 M-12: MODEINITFIX + OFF path — insert branch forcing `vbs=vgs=vds=0` | REWRITE POST-A1 | Branch inside `load()`. G1 also applies (vbs naming/sign). |
| 6.2.11 Companion junction zero fix (#32) — stop zeroing SLOT_CCAP_DB/SB on MODEINITTRAN; only zero gate-cap companions | REWRITE POST-A1 | Direct reference to A1-deleted cap slots. Becomes a non-issue once companions are locals. |

#### Wave 6.3 — Verification

| Task | Verdict | Route / note |
|---|---|---|
| 6.3.1 PMOS `tVbi` sign audit (#25) — verify PMOS against ngspice via harness | CARRY AS-IS | Verification task using the comparison harness. G1 sign-convention resolution likely clarifies. |

### Phase 7 — F5ext (JFET Full Convergence Port)

Every task operates on JFET `_updateOp` / `_stampCompanion` split or on the A1-deleted cross-method cap/ieq slots.

#### Wave 7.1 — NJFET core

| Task | Verdict | Route / note |
|---|---|---|
| 7.1.1 Diff 3.1: State schema rewrite — rename `SLOT_GD_JUNCTION`→`SLOT_GGS_JUNCTION`, add VGD/GGD/CGD/CD/QGS/QGD/CQGS/CQGD slots | REWRITE POST-A1 | Schema under A1: cross-method slots (`CQGS`, `CQGD` = cap transfer) deleted; junction-voltage and charge slots (VGS/VGD/QGS/QGD) survive. The rename of GD_JUNCTION→GGS_JUNCTION is an A1-independent naming-alignment edit. |
| 7.1.2 Diff 3.2: Accessor getters/setters for new slots + renames | REWRITE POST-A1 | Accessor set shrinks under A1. |
| 7.1.3 Diff 3.3: Add `limitVgd`; `DEVfetlim` + `DEVpnjlim` on vgs; gate-drain pair limiting | PAUSE-UNTIL-A1 | Limiting call ordering lives inside unified `load()`. |
| 7.1.4 Diff 3.4: Rewrite `primeJunctions` — 3-branch MODEINITJCT per `jfetload.c:109-122` | REWRITE POST-A1 | Priming called from unified `load()` post-A1. |
| 7.1.5 Diff 3.5: MODEINITPRED + full `_updateOp` rewrite — state-copies, xfact extrapolation, predictor, Shockley diode, Sydney drain current | PAUSE-UNTIL-A1 | The task literally rewrites `_updateOp` — the method A1 deletes. Authored against unified `load()` post-A1. |
| 7.1.6 Diff 3.6: JFET-specific `checkConvergence` — replace inherited MOS1convTest | REWRITE POST-A1 | Overrides method on the split-architecture base class; re-authored post-A1. |
| 7.1.7 Diff 3.7: Rewrite `_stampNonlinear` — 16 Y-matrix + 3 RHS stamps per `jfetload.c:521-550` | PAUSE-UNTIL-A1 | The task literally rewrites `_stampNonlinear` — the method A1 deletes. Merges into `load()` post-A1. |

#### Wave 7.2 — PJFET collapse

| Task | Verdict | Route / note |
|---|---|---|
| 7.2.1 Diff 4.2: Delete PJFET `_updateOp` override — delegate to polarity-aware base | REWRITE POST-A1 | Override targets the A1-deleted method; post-A1 PJFET simply delegates to a polarity-aware base `load()`. |
| 7.2.2 Diff 4.3: Delete PJFET `_stampNonlinear` override — delegate to polarity-aware base | REWRITE POST-A1 | Same rationale. |
| 7.2.3 Diff 4.4: Delete PJFET `primeJunctions` override — delegate to base | REWRITE POST-A1 | Priming call site moves into post-A1 `load()`. |

#### Wave 7.3 — Test alignment

| Task | Verdict | Route / note |
|---|---|---|
| 7.3.1 Update test imports — replace `SLOT_GD_JUNCTION`/`SLOT_ID_JUNCTION` with `stateSchema.getSlotOffset("GGS_JUNCTION")`/`("CG_JUNCTION")` | REWRITE POST-A1 | Schema-lookup rule applies; the surviving slot set post-A1 differs from what this task assumes. Tests hand-computing expected values on A1-deleted slots are deleted per A1 test-handling rule. |

### Phase 8 — F6 (Documentation & Citations)

#### Wave 8.1 — Spec artifacts

| Task | Verdict | Route / note |
|---|---|---|
| 8.1.1 Append Wave C5 completion-status block to `spec/phase-catchup.md` | CARRY AS-IS | Documentation-only. |
| 8.1.2 Append 2026-04-20 divergences addendum to `spec/ngspice-alignment-divergences.md` | SATISFIED-BY I2 | `ngspice-alignment-divergences.md` is superseded by `architectural-alignment.md` per the header of the replacement doc. Appending to a superseded file is obsolete. The citation-audit intent migrates to 8.1.3 / I2 policy. |
| 8.1.3 Create `spec/ngspice-citation-audit.md` verbatim from F6 Deliverable 8 (58-row table, status defs, priority corrections, maintenance protocol) | CARRY AS-IS | Citation audit is the concrete artefact I2 policy mandates. |

#### Wave 8.2 — Citation corrections in source

| Task | Verdict | Route / note |
|---|---|---|
| 8.2.1 6 citation corrections per priority list entries #1–6 in `dc-operating-point.ts` | CARRY AS-IS | Citation text; I2 policy. Line numbers shift under C1 (dcopFinalize rewrite) — re-target against post-C1 code. |
| 8.2.2 Correct lines 62/79 (pnjlim — now resolved by Phase 4), 236 → `cktntask.c:97`, 408 → `niiter.c:1012-1046` | CARRY AS-IS | Citation text. Line numbers shift; re-target against post-D4/B5 code. |
| 8.2.3 Replace `niiter.c:991-997` with `niiter.c:1050-1085` on line 82 of `analog-types.ts` | CARRY AS-IS | Citation text. |

### Phase 9 — Legacy Reference Review

#### Wave 9.1 — Full audit

| Task | Verdict | Route / note |
|---|---|---|
| 9.1.1 Grep for every removed identifier | CARRY AS-IS **with expanded identifier list** | Original list: `PIVOT_THRESHOLD`, `PIVOT_ABS_THRESHOLD`, `_firsttime`, `statePool.analysisMode`, `loadCtx.iteration`, `SLOT_GD_JUNCTION`, `SLOT_ID_JUNCTION`, `InitMode` type, `ctx.initMode`, `ctx.isDcOp`, `ctx.isTransient`, `ctx.isTransientDcop`, `ctx.isAc`, `Math.exp(700)`, `Math.min(..., 700)`, `junctionCap`, banned Vds clamp `(vds < -10)`, `firstNrForThisStep`, `"transient"` initMode sentinel, `predictor` SimulationParams field, `MNAAssembler`. **Add under Track A (Phase 2.5):** `_updateOp`, `_stampCompanion`, `SLOT_CAP_GEQ`, `SLOT_CAP_IEQ`, `L1_SLOT_CAP_GEQ_BE`, `L1_SLOT_CAP_GEQ_BC_INT`, `L1_SLOT_CAP_GEQ_BC_EXT`, `L1_SLOT_CAP_GEQ_CS`, `L1_SLOT_IEQ_BE`, `L1_SLOT_IEQ_BC_INT`, `L1_SLOT_IEQ_BC_EXT`, `SLOT_CAP_GEQ_GS`/`_GD`/`_DB`/`_SB`/`_GB`, `SLOT_IEQ_GS`/`_GD`/`_DB`/`_SB`/`_GB`, `SLOT_Q_GS`/`_GD`/`_GB`/`_DB`/`_SB` (MOSFET cross-method Q/cap transfer slots), JFET `SLOT_CAP_GEQ_GS`/`_GD`/`SLOT_IEQ_GS`/`_GD`, `pool.uic`, `poolBackedElements`, `refreshElementRefs`, `TUNNEL_DIODE_MAPPING`, `VARACTOR_MAPPING`, `derivedNgspiceSlots`, `VSB`/`VBD` (MOSFET old sign-convention names), VSB-sign-flip derivation, `ctx.noncon` dual-storage setter. |
| 9.1.2 Audit comment citations: random sample 10 ngspice citations; verify against `ref/ngspice/` | CARRY AS-IS | I2 policy in practice. |
| 9.1.3 Run full suite: `npm test`. Capture failures as final acceptance input for the out-of-plan ngspice parity harness mission | CARRY AS-IS | Final gate. |

## Summary counts

| Verdict | Count |
|---|---|
| CARRY-AS-IS | 22 |
| SATISFIED-BY | 21 |
| PAUSE-UNTIL-A1 | 18 |
| REWRITE-POST-A1 | 37 |
| **Total remaining tasks classified** | **98** |

(Counts cover every sub-task enumerated in plan.md Phases 2–9. Phases 0 and 1 complete and out of scope per the reconciliation-task.md input.)

Phase with the most REWRITE-POST-A1 tasks: **Phase 5 (BJT)** — 12 REWRITE + 6 PAUSE out of 21 sub-tasks. Phase 6 (MOSFET) has 9 REWRITE + 3 PAUSE out of 14. Phase 7 (JFET) has 7 REWRITE + 3 PAUSE out of 11. All three device phases operate almost entirely on the `_updateOp`/`_stampCompanion` split that A1 deletes, as predicted in `spec/reconciliation-task.md` §Layer 3.

## Execution sequencing

The dependency graph in `plan.md` gets one new node inserted between Phase 2 and Phase 3:

```
Phase 2 (F3+F4 cktMode + LoadContext)      ─── finish in flight
  │
Phase 2.5 (Track A execution — atomic)     ─── NEW (see architectural-alignment.md)
  │                                             A1 umbrella + A2/A3/A4 + F2 + F4a/F4b
  │                                             + G1 + H1/H2 + I1 cleanup
  │
Phase 3 (F2 NR reorder + predictor)        ─── 3.2 PAUSE tasks re-authored here;
  │                                             3.1 CARRY; 3.3 SATISFIED-BY
  │
Phase 4 (F5 limiting)                      ─── 4.1.1/4.1.4/4.2.1/4.3.1 SATISFIED;
  │                                             4.1.2 PAUSE; rest CARRY or REWRITE
  │
Phase 5/6/7 (F-BJT / F-MOS / F5ext-JFET)   ─── PAUSE/REWRITE tasks re-authored here
  │                                             against post-A1 `load()` structure
  │
Phase 8 (F6 docs) + Phase 9 (legacy audit) ─── largely CARRY-AS-IS
                                               Phase 9 identifier list expanded with
                                               A1-deleted symbols (see 9.1.1 note)
```

## Notes on classification

- `Wave 2.1.1` (create `ckt-mode.ts`) is classified SATISFIED-BY rather than CARRY because the bitfield helpers are load-bearing for C2 and C3 — Track A execution needs them regardless, so they land as part of Track A rather than as a standalone plan wave.
- `Wave 4.1.2` (BJT LoadContext extensions) is PAUSE rather than REWRITE because the *field list itself* changes under A1 (most of those fields were cross-method transfers that become locals). The task needs re-authoring, not line-number shifts.
- Phase 5/6/7 uniformly PAUSE-or-REWRITE matches the `spec/reconciliation-task.md` §Layer 3 prediction. No device-phase task survived classification as CARRY except parameter-plumbing (5.1.5, 5.2.7, 5.2.8), comment-only (6.2.8), and LTE-hook (6.1.2) work — each of those operates on orthogonal surfaces.
- Wave 8.1.2 is SATISFIED-BY I2 rather than flagged as an unreachable OBSOLETE: I2 policy governs the replacement-by-architectural-alignment.md, so "stop appending to the superseded doc" is the concrete remedy.
- Every Track A ID cited (A1, A2, A3, A4, B4, B5, C1, C2, C3, D2, D3, D4, E2, E3, F2, F4a, F4b, F4c, G1, H1, H2, I1, I2) is present in `spec/architectural-alignment.md` §1 Summary table.
