# Layer 2 Verification Notes — Group D

**Date:** 2026-04-21
**Scope:** 16 verdict rows (D-1, D-2a, D-2b, D-3..D-15 per fix-list § "Group D")

---

## Per-item verdicts

### D-1. Remove `Math.min(vd/nVt, 700)` clamp from diode.ts:344
- **L1 tag:** PARITY
- **Verification grep result:** `Math\.min\([^)]*700\)` in `diode.ts` → **0 hits** (matches requirement).
- **DONE?:** YES
- **Cited ngspice source:** `ref/ngspice/src/spicelib/devices/dio/dioload.c:244` — `evd = exp(vd/vte);` — no clamp. The fix-list specifies unconditional `Math.exp(vd / nVt)` matching this line.
- **Current file state:** `src/components/semiconductors/diode.ts:345`: `const evd = Math.exp(vd / nVt);` with comment citing `dioload.c:247` (equivalent block). The forward-bias branch is now clamp-free.
- **I1 violation check:** No `Math.min` wrapping `vd/nVt`. No suppression, no save/restore. Comment cites ngspice line directly. Reverse-smooth / breakdown branches (346-354) use their own ngspice-cited formulas.
- **Verdict:** ACTUALLY-COMPLETE
- **Rationale:** Clamp removed verbatim; matches `dioload.c:244` (citation gives 247; either is within the same "evd=exp" block — both are MOS1load-style forward-bias formulas with no clamp).

### D-2a. Diode — re-align state schema and implement MODEINITSMSIG body
- **L1 tag:** BLOCKER → A1 (+ D2)
- **Verification greps:**
  - `SLOT_CAP_GEQ\b` in `diode.ts` → **0 hits** (diode.ts shows `SLOT_CAP_CURRENT, SLOT_V, SLOT_Q, SLOT_CCAP` only).
  - `SLOT_CAP_IEQ\b` in `diode.ts` → **0 hits**.
  - `SLOT_CAP_CURRENT\b` in `diode.ts` → **2 hits** (lines 656 MODEINITSMSIG write, 662 MODETRAN write — as required).
  - IMPLEMENTATION FAILURE marker `"LATENT divergence"` → **0 hits**.
- **DONE?:** YES
- **Cited ngspice source:** `dioload.c:362-374` (MODEINITSMSIG body writing capd, then `continue`); `dioload.c:395-401` (MODETRAN writes iqcap). Citation lines appear verbatim in the diode source comments (651-657, 661).
- **Current file state:** Lines 73-76 declare `SLOT_CAP_CURRENT` with dual-semantic comment citing `dioload.c:363`. Lines 651-659 implement MODEINITSMSIG branch with `s0[base + SLOT_CAP_CURRENT] = Ctotal; return;`. Line 662 does the MODETRAN write of `ccap`.
- **I1 violation check:** The MODEINITSMSIG branch uses `return` rather than ngspice's `continue` (the enclosing loop in dioload iterates over devices; in digiTS this is per-element, so `return` is the semantic equivalent — not a suppression). Extra guard `!((mode & MODETRANOP) && (mode & MODEUIC))` on line 654 is cited to `dioload.c:360` (small-signal parameter store-back gate). No suppression, no hand-computed value, no save/restore. The comment block uses ngspice-only citation language.
- **Verdict:** OBSOLETE-BY-A1
- **Rationale:** L1 tag routes to A1. The entire `load()` body shown is on the surface A1 collapses; post-A1 rewrite re-authors this from scratch against `dioload.c`. The pre-A1 implementation is ngspice-aligned enough to not introduce new I1 violations that would survive. The invented `SLOT_CAP_GEQ/IEQ` slots were removed, which is consistent with A1 direction.

### D-2b. Cross-device audit for vestigial cap-Norton slots
- **L1 tag:** OBSOLETE
- **Verification grep result:** The fix-list item is explicitly labeled "PHASE 2.5 FOLLOW-UP, NOT BLOCKING" and "Do NOT perform this audit during D-2a execution." No new audit infrastructure was searched for/found; MOSFET still uses `SLOT_CAP_IEQ_DB` at lines 1562/1686/1690/1695, BJT still uses `L1_SLOT_CAP_GEQ_*` reads. No tolerance-constants / mapping-tables file was introduced.
- **DONE?:** Not applicable — this is explicitly a non-work item.
- **I1 violation check:** No audit infrastructure invented (no new "audit" .md, no tolerance tables, no mapping-equivalence scaffolding).
- **Verdict:** OBSOLETE-BY-A1
- **Rationale:** L1 tag is OBSOLETE; confirmed no work was done (which is correct — the item was designed as a non-task). A1 execution collapses the cross-device pattern wholesale.

### D-3. Rewrite diode MODEINITJCT dispatch to match dioload.c:129-136
- **L1 tag:** BLOCKER → A2
- **Verification greps:**
  - `pool\.uic` in `diode.ts` → **0 hits**.
  - `MODEINITFIX` in `diode.ts` → **3 hits** (import, line 509 dispatch, line 676 OFF gate).
- **DONE?:** YES
- **Cited ngspice source:** `dioload.c:129-136` — MODEINITJCT verbatim with OFF / UIC / else(vcrit) branches; `dioload.c:137-138` for MODEINITFIX&&OFF.
- **Current file state:** Lines 500-511 implement the dispatch in ngspice order:
  - Line 502: `if ((mode & MODETRANOP) && (mode & MODEUIC))` → `vdRaw = params.IC`
  - Line 504: `else if (params.OFF)` → `vdRaw = 0`
  - Line 506: else → `vdRaw = tVcrit`
  - Line 509: MODEINITFIX && OFF branch added.
- **I1 violation check:** Uses bitfield checks against `mode`, not `pool.uic`. Comments cite exact ngspice lines (131-132, 133-134, 135-136, 137-138). No hand-computed values; params.IC/tVcrit/0 mirror ngspice verbatim. No suppression.
- **Verdict:** ACTUALLY-COMPLETE
- **Rationale:** Bitfield-based dispatch + MODEINITFIX branch added; dispatch order matches ngspice. This is numerical/dispatch work that survives A1 (the init-mode cascade is authored inside A1's new `load()` but this exact sequence is what ngspice requires).

### D-4. Fix BJT L1 store-back values (write capbe/capbc/capsub, not CTOT)
- **L1 tag:** BLOCKER → A1
- **Verification grep result:** `L1_SLOT_CAP_GEQ_BE\]\s*=\s*s0\[base\s*\+\s*L1_SLOT_CTOT_BE\]` in `bjt.ts` → **0 hits** (the wrong store-back is gone).
- **DONE?:** YES
- **Cited ngspice source:** `bjtload.c:676-680`. Not independently verified via ngspice source inspection in this pass — relying on the grep-only completion criterion from the fix-list.
- **I1 violation check:** Not deeply inspected; grep-based verdict per fix-list protocol.
- **Verdict:** OBSOLETE-BY-A1
- **Rationale:** L1 tag routes to A1; the CAP_GEQ_* slots A1 deletes wholesale. Even if the replacement store-back is present, it is on the soon-deleted surface.

### D-5. Remove `dt > 0` from BJT L1 capGate (MODEINITSMSIG unreachable during AC)
- **L1 tag:** BLOCKER → D3
- **Verification grep result:** `capGate\s*&&\s*dt\s*>\s*0` in `bjt.ts` → **0 hits**.
- **DONE?:** YES
- **Cited ngspice source:** `bjtload.c:561-563` — no `dt > 0` gate on MODEINITSMSIG. Not independently inspected; grep matches fix-list expectation.
- **I1 violation check:** The `dt > 0` gate (a suppression pattern that made MODEINITSMSIG unreachable) was removed.
- **Verdict:** ACTUALLY-COMPLETE
- **Rationale:** Direct removal of a suppression gate, cited to `bjtload.c`. D3 in `architectural-alignment.md` is exactly this fix — this is D3's concrete code change, and it survives A1 (the semantics carry into the new BJT `load()`).

### D-6. Use `=== MODETRANOP` form for UIC branch in BJT L1
- **L1 tag:** BLOCKER → A2
- **Verification grep result:** `\(mode\s*&\s*MODETRANOP\)\s*&&` in `bjt.ts` → **0 hits** (either replaced with `=== MODETRANOP` or rewritten).
- **DONE?:** YES
- **Cited ngspice source:** `bjtload.c:579-587` — explicit bit-equality / `!== 0` form. Not independently inspected.
- **I1 violation check:** Truthy-coercion pattern removed; no pool.uic read in the UIC branch.
- **Verdict:** OBSOLETE-BY-A1
- **Rationale:** L1 tag routes to A2 (pool.uic deletion); A1 rewrites the BJT `load()` and re-authors the UIC branch with the correct bit-equality form. The current state is on the surface A1 collapses.

### D-7. Add vbx rhsOld seeding in BJT L1 MODEINITSMSIG block
- **L1 tag:** BLOCKER → A1
- **Verification grep result:** `vbx\s*=\s*[^;]*rhsOld` in `bjt.ts` → **3 hits** (lines 1508, 1514, 1520).
- **DONE?:** YES
- **Cited ngspice source:** `bjtload.c:240-244` (MODEINITSMSIG vbx/vsub seeding) and `bjtload.c:248-250` (MODEINITTRAN vbx seeding). Not independently inspected.
- **Current file state:** bjt.ts:1510-1521 — MODEINITSMSIG branch seeds `vbx` and `vsub` from rhsOld with polarity-weighted subtraction; MODEINITTRAN branch also seeds vbx/vsub. Comments cite bjtload.c:239-241, 242-244, 248-250, 251-253.
- **I1 violation check:** No hand-computed values; expressions are direct node-difference forms with polarity factor — matches the ngspice formula shape.
- **Verdict:** OBSOLETE-BY-A1
- **Rationale:** L1 tag routes to A1. Code is on the BJT `load()`-split surface A1 rewrites; the seeding logic is ngspice-aligned and would survive into the rewrite, but the specific structural placement inside the `_updateOp`/`_stampCompanion` split is obsoleted.

### D-8. Fix MOSFET `cgs_cgd_transient_matches_ngspice_mos1` regression
- **L1 tag:** PARITY (2026-04-21 user ruling: regression canary)
- **Verification grep result:** Fix-list specifies "responsible code block in `mosfet.ts` has been re-derived verbatim from `mos1load.c`, with a comment citing the exact ngspice line." `useDoubleCap` is used at lines 1185, 1763, 1832, 1917 with consistent `(MODETRANOP | MODEINITSMSIG)` gate and `mos1load.c:789-795` citations. `SLOT_CAP_IEQ_DB` is written at lines 1686 (normal), 1690 (guarded zero), 1695 (fallback zero).
- **DONE?:** Partially DONE (code structure in place, citation comments present), but the regression itself is explicitly kept as a canary (fix-list D-8: "kept as a regression canary; re-measured against ngspice after A1 lands").
- **Cited ngspice source:** `mos1load.c:789-795` (doubling guard). Not independently verified against the specific expected `-3.549928774784246e-12` value — the user ruling accepts the divergence as a canary pending A1.
- **I1 violation check:** The `useDoubleCap` pattern and the `SLOT_CAP_IEQ_DB = 0` guards could be read as suppression, but are explicitly cited to `mos1load.c:789-795` ("MODETRANOP or MODEINITSMSIG uses 2×state0; all others 0"). This is a structural doubling-guard mirroring ngspice, not a silent suppression. Comment citations exist at each use site.
- **Verdict:** ACTUALLY-COMPLETE (as a PARITY canary)
- **Rationale:** Per 2026-04-21 user ruling this is a kept canary re-measured post-A1. The code has the citation structure the fix-list required. The actual numerical divergence is a canary awaiting A1 execution, not a defect to close here.

### D-9. Delete redundant duplicate `_ctxCktMode` write in mosfet.ts:1196
- **L1 tag:** BLOCKER → A1
- **Verification grep result:** Inside `_updateOp` body — `_ctxCktMode\s*=` → **0 hits** (no matches across whole file).
- **DONE?:** YES
- **Current file state:** mosfet.ts:1195-1199 `_updateOp` is a small delegating wrapper; the base-class write at `fet-base.ts:260` is the single site.
- **I1 violation check:** No duplicate. No suppression.
- **Verdict:** OBSOLETE-BY-A1
- **Rationale:** L1 tag routes to A1. The `_ctxCktMode` field itself is a cross-method cache that A1 deletes entirely. Pre-A1 deletion of the duplicate write is harmless but on a soon-deleted surface.

### D-10. Split fet-base capGate — abstract `_capGate(ctx)` override per device
- **L1 tag:** BLOCKER → A1
- **Verification greps:**
  - `_capGate\s*\(` in njfet.ts + pjfet.ts + mosfet.ts → **1 hit each** (definitions at lines 394 njfet, 247 pjfet, 1202 mosfet).
  - `fet-base.ts` → `_capGate` at lines 267 (call site) + 746 (abstract declaration).
  - mosfet `_capGate` body (line 1204): `(cktMode & (MODETRAN | MODETRANOP | MODEINITSMSIG)) !== 0` — no MODEAC, MODETRANOP unconditional. ✓ Matches fix-list and `mos1load.c:762`.
  - njfet `_capGate` body (lines 396-397): `(cktMode & (MODETRAN | MODEAC | MODEINITSMSIG)) !== 0 || ((cktMode & MODETRANOP) !== 0 && (cktMode & MODEUIC) !== 0)` — MODEAC present, MODETRANOP/MODEUIC conjunction present. ✓ Matches fix-list and `jfetload.c:425-426`.
- **DONE?:** YES
- **Cited ngspice source:** `jfetload.c:425-426` (JFET), `mos1load.c:762` (MOSFET). Comments at each override cite the exact ngspice file.
- **I1 violation check:** Abstract method is a clean class-hierarchy split; no suppression. Per-device body mirrors the ngspice gate expression.
- **Verdict:** OBSOLETE-BY-A1
- **Rationale:** L1 tag routes to A1. Per L1 annotation: "the class-hierarchy split itself becomes obsolete under A1's procedural-load structure" — each device's capGate lives inline in the new `load()` post-A1. The pre-A1 form is ngspice-aligned and would port cleanly but the abstract-method infrastructure vanishes.

### D-11. Rewrite fet-base.ts:194-196 comment
- **L1 tag:** OBSOLETE
- **Verification grep result:** Not independently verified (pure comment change).
- **DONE?:** Not critical — L1 OBSOLETE because the cache field being commented is deleted by A1.
- **I1 violation check:** Comment-only change; no semantic impact.
- **Verdict:** OBSOLETE-BY-A1
- **Rationale:** L1 tag OBSOLETE. The `_ctxCktMode` field itself disappears under A1; any comment referencing it goes with it.

### D-12. Capacitor test `stampCompanion preserves V_PREV`
- **L1 tag:** BLOCKER → A1 (per A1 §Test handling rule)
- **Verification grep result:** `makeCaptureSolver\(\)` count inside this test body (lines 301-318) → **1 hit at line 309** — test reuses a single solver mock. Per fix-list expectation, count=1 is correct.
- **DONE?:** YES
- **Current file state:** Test uses a single `makeCaptureSolver` call and two `element.load()` calls against the same solver (lines 309, 312, 316). No handle reset dance.
- **I1 violation check:** **This test inspects `pool.state0[2]` (V_PREV) between two `load()` calls — an intermediate-pool-state inspection pattern.** Per A1 §Test handling rule: "Any assertion whose expected value was computed by hand, rather than produced by ngspice, is subject to deletion during A1." The expected values (3.0 then 7.0) are the input voltages passed into `load()` — not quite "hand-computed" (they're identity), but the whole pattern of inspecting intermediate pool slots between compute and stamp is exactly what A1 eliminates.
- **Verdict:** OBSOLETE-BY-A1
- **Rationale:** L1 tag routes to A1. The test's "inspect pool slot between load() calls" pattern ceases to be meaningful when `_updateOp`/`_stampCompanion` collapse. Pre-A1 fix (single solver mock) is ngspice-unrelated housekeeping; the test itself is slated for deletion/re-authoring under A1 §Test rule.

### D-13. Capacitor test `stampCompanion_uses_s1_charge_when_initPred`
- **L1 tag:** BLOCKER → A1 (per A1 §Test handling rule — hand-computed expected value)
- **Verification greps:**
  - `toBeCloseTo\(-7` → **0 hits**.
  - `toBeCloseTo\(-3` → **1 hit at line 426** (as required).
- **DONE?:** YES (test value changed from -7 to -3).
- **Current file state:** Lines 399-427. Expected `ceq` = -3; comment at lines 421-425 derives `q0 = C*3 = 3e-6`, `ccap = (1/dt)*3e-6 + (-1/dt)*3e-6 = 0`, `ceq = ccap - ag[0]*q0 = -3 at dt=1e-6`.
- **I1 violation check:** **THE HAND-COMPUTED EXPECTED VALUE IS THE DEFINING ISSUE.** The comment block lines 421-425 explicitly derives ceq=-3 from `q0`, `ag[0]`, `dt` — this is a hand-computation from intermediate pool-slot semantics. The test also inspects `pool.states[0][0]` (SLOT_GEQ) and `pool.states[0][1]` (SLOT_IEQ) — exactly the invented Norton-companion slots A1 deletes. **Per A1 §Test handling rule: "Any assertion whose expected value was computed by hand, rather than produced by ngspice, is subject to deletion during A1." This test is a textbook example.**
- **Verdict:** PAPERED-RE-OPEN
- **Rationale:** The "fix" replaced one hand-computed expected value (-7) with another hand-computed expected value (-3). Even if the -3 derivation matches the digiTS formula, it's still a hand-computation on a pool slot (SLOT_IEQ = invented Norton companion) that has no ngspice counterpart. This is a test-chasing fix on a test that A1 §Test handling rule flags for deletion. It is I1-suppression at the test layer per the A1 analysis. Re-open and delete under A1 execution.

### D-14. Inductor test `stamps branch incidence and conductance entries` (expected count 4 → 5)
- **L1 tag:** BLOCKER → A1 (per A1 §Test handling rule)
- **Verification greps:**
  - `toBe\(4\)` in this test body → **0 hits**.
  - `toBe\(5\)` at line 180 → **1 hit** (as required).
- **DONE?:** YES (count changed 4 → 5).
- **Current file state:** Lines 153-191. Expected `stamps.length = 5` with comment citing `indload.c:119-123` (unconditional `-req` on branch diagonal).
- **I1 violation check:** **Hand-computed structural expectation.** The comment at lines 176-179 hand-enumerates "2 B-matrix + 2 C/D-matrix + 1 branch diagonal = 5". The subsequent assertions (lines 184-190) hand-verify specific (row, col, value) tuples. Per A1 §Test handling rule, "any assertion whose expected value was computed by hand" is slated for deletion during A1. Citing `indload.c:119-123` does not make the stamp-count hand-computation ngspice-bit-exact — ngspice does not expose a "stamps.length" quantity at all, so this is structurally a digiTS-only invariant.
- **Verdict:** PAPERED-RE-OPEN
- **Rationale:** The fix changed a hand-computed 4 to a hand-computed 5. The test asserts structural properties of digiTS's stamp-capture helper, not a quantity ngspice exposes. It inspects stamp tuples by (row,col,value) — a digiTS-internal mechanism. Per A1 §Test handling rule and I1 stricter policy ("tests whose expected values come from the harness survive; hand-computed tests are deleted"), this is PAPERED-RE-OPEN. Test re-authored or deleted under A1 execution.

### D-15. Capacitor default `_IC = 0.0` (match ngspice `CAPinitCond`)
- **L1 tag:** PARITY
- **Verification greps:**
  - `_IC:\s*NaN` in `capacitor.ts` → **0 hits**.
  - `isNaN\(this\._IC\)` in `capacitor.ts` → **0 hits**.
  - `IC: { default: 0.0, ...}` at line 48 (confirmed).
  - cond1 gate at lines 271-273: `((mode & MODEDC) && (mode & MODEINITJCT)) || ((mode & MODEUIC) && (mode & MODEINITTRAN))` — no isNaN guard.
  - `vcap = this._IC` at line 278 — unconditional under cond1.
- **DONE?:** YES
- **Cited ngspice source:** `cap.c` (CAPinitCond default = 0.0); `capload.c:46-47` (unconditional cond1 use). Not independently inspected, but the current code matches the fix-list's verbatim spec.
- **Current file state:** `CAPACITOR_DEFAULTS.IC` = 0.0 (line 48). `cond1` at line 271-273 is ngspice-form without NaN guard. Line 278 `vcap = this._IC` is unconditional.
- **I1 violation check:** No NaN sentinel, no silent guard, no "if defined" suppression. Matches ngspice `CAPinitCond` semantics exactly.
- **Verdict:** ACTUALLY-COMPLETE
- **Rationale:** Default value and unconditional cond1 use match `cap.c`/`capload.c:46-47` as required. This is a genuine numerical parity fix that stands on its own; it does not sit on the `_updateOp`/`_stampCompanion` split (capacitor.ts uses a single `load()`). Survives A1.

---

## Summary counts

- **ACTUALLY-COMPLETE: 5** — D-1, D-3, D-5, D-8 (canary), D-15
- **OBSOLETE-BY-TRACK-A: 9**
  - Route to A1: D-2a, D-2b (also OBSOLETE), D-4, D-7, D-9, D-10, D-11, D-12
  - Route to A2 (via A1's BJT rewrite): D-6
- **PAPERED-RE-OPEN: 2** — D-13, D-14
- **OPEN (never done): 0**
- **Total: 16 verdict rows (D-1, D-2a, D-2b, D-3..D-15)**

Note: Fix-list summary says "15 items"; counting D-2 as a single item gives 15. Treating D-2a and D-2b as separate rows gives 16. Both counts consistent with task brief.

---

## PAPERED-RE-OPEN items

- **D-13 (capacitor `stampCompanion_uses_s1_charge_when_initPred`)** — Fix replaced hand-computed expected value -7 with hand-computed -3. Inspects invented SLOT_GEQ/SLOT_IEQ pool slots A1 deletes. Per A1 §Test handling rule this hand-computed assertion is slated for deletion; per I1 stricter policy, hand-computed expected values on intermediate pool state are suppression at the test layer. Re-open; resolve under A1 execution.
- **D-14 (inductor `stamps branch incidence and conductance entries`)** — Fix replaced hand-computed stamp count 4 with hand-computed 5. The quantity asserted (`stamps.length`) is a digiTS-only stamp-capture mechanism; ngspice does not expose it. Citing `indload.c:119-123` does not make the structural count ngspice-bit-exact. Per A1 §Test handling rule, re-authored or deleted under A1.

---

## Flags for user review

### Borderline verdicts

- **D-8 (MOSFET cgs_cgd regression)** — Verdict ACTUALLY-COMPLETE is conditional on the 2026-04-21 user ruling that the regression is kept as a PARITY canary awaiting post-A1 re-measurement. The underlying numerical divergence still exists (`+0` vs `-3.549928774784246e-12`). If the verification standard requires the regression actually resolved, this is OPEN; if the standard accepts the canary pattern, it is COMPLETE. The L1 tag affirms canary status.
- **D-2a (diode MODEINITSMSIG body)** — The `continue` → `return` substitution is semantically equivalent (digiTS iterates per-element; ngspice's `continue` skips to the next device in a for-loop). This is not a banned "equivalent to" closure — it is a language-mechanism difference where the loop boundary moves from ngspice's outer-for to digiTS's per-element call. Flagged because the L1 banned-verdict vocabulary rule is strict; user may want to confirm this as a framework-boundary concern rather than a numerical claim.

### Unverifiable claims

- **D-4, D-5, D-6, D-7:** The ngspice source lines cited (`bjtload.c:561-563`, `:579-587`, `:240-244`, `:676-680`) were not inspected via direct reads of `ref/ngspice/src/spicelib/devices/bjt/bjtload.c` in this verification pass. Verdicts rely on grep-based completion criteria per the fix-list protocol. If a deeper audit is desired, those files must be read against the bjt.ts implementations.
- **D-8 (ngspice `mos1load.c:789-795` doubling guard):** Not independently inspected. The digiTS `useDoubleCap` pattern is consistent with the cited line-range meaning ("MODETRANOP or MODEINITSMSIG uses 2×state0; all others 0") but a bit-exact ngspice read would strengthen the verdict.

### I1 violations surfaced that survive in code

- **D-13 and D-14 (tests):** Hand-computed expected values on intermediate pool slots / stamp counts. These are the I1 violations that survive into the A1 rewrite and must be removed during A1 execution per the §Test handling rule.
- **D-8 (MOSFET `SLOT_CAP_IEQ_DB = 0` at mosfet.ts:1690, 1695):** The zero-assignment branches under non-(MODETRANOP|MODEINITSMSIG) paths could read as suppression gates. The cited `mos1load.c:789-795` comment frames them as structural ngspice-matched behavior. If the fix-list D-8 canary resolves post-A1, these assignments should also be re-audited.
- **D-2a (diode guard `!((mode & MODETRANOP) && (mode & MODEUIC))` at line 654):** Cited to `dioload.c:360` but the citation line was not independently verified. If that gate does not exist in dioload.c exactly, it would be a suppression gate added during digiTS implementation — flagging for A1-execution re-audit.
