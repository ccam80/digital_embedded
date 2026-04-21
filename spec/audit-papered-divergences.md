# Audit — Papered-Over Architectural Divergences from ngspice

**Date**: 2026-04-21
**Trigger**: user flag after the Phase 2 9-reviewer audit exposed that `SLOT_CAP_GEQ`/`SLOT_CAP_IEQ` in the diode state pool are digiTS inventions with no ngspice counterpart. The user asked whether this "papering-over" pattern repeats elsewhere.
**Scope**: the 9 review reports in `spec/reviews/phase-*.md`, `spec/progress.md`, the F-series specs, `spec/ngspice-alignment-divergences.md`, `spec/ngspice-alignment-verification.md`, `spec/fix-list-phase-2-audit.md`, and comments in `src/` that acknowledge divergence from ngspice.
**Purpose**: enumerate every instance where a **structural / architectural** mismatch with ngspice has been recorded in the codebase, in reviews, in progress notes, or in spec files — but treated as a minor naming / semantic / "equivalent" issue rather than as the architectural decision it actually is.

---

## Meta-finding

The project has a documented divergences file (`ngspice-alignment-divergences.md`, 17 items) plus a grading/verification file (`ngspice-alignment-verification.md`), but the grading scheme treats architectural divergences as if they were numerical. Architectural divergences get labeled "intentional", "equivalent", or "for diagnostics" — and that framing gets copied into the F-series specs, into progress.md entries, and into in-code comments.

**The pattern that has been papered over is not any single slot or field — it is the habit of classifying structural mismatches as "numerical divergences with workarounds".** This makes IEEE-754 per-NR-iteration parity (the master acceptance criterion in `plan.md` Appendix A) structurally impossible even after every F-spec is fully implemented.

---

## Tally

| Category | Count |
|---|---|
| State-schema inventions (slots with no ngspice counterpart) | 7 |
| Pool architecture (statePool / analysisMode / uic / refreshElementRefs / poolBackedElements) | 5 |
| Cross-method state buffering (compute in `_updateOp`, stamp in `_stampCompanion`) | 3 |
| Model architecture (`modelRegistry`, `defaultModel`, `spice-l0..l3`, behavioral-*) | 3 |
| Bridge / adapter / engine-agnostic layers | 4 |
| `cktLoad` signature + `iteration` / noncon extras | 3 |
| Solver fields (`_hasPivotOrder`, `_didPreorder`, snapshot, preFactorMatrix) | 3 |
| Band-aid commits papering over structural divergences | 4+ |
| Spec entries labelled "divergence" that are architectural, not numerical | 6 |
| **TOTAL** | **~38** |

---

## Critical items — numerical incorrectness or block per-NR ngspice parity

### C-AUD-1. Diode state schema invents `SLOT_CAP_GEQ` + `SLOT_CAP_IEQ`
**Reconciliation:** BLOCKER → A1 (APPROVED FIX) — A1 collapses `_updateOp`/`_stampCompanion`, deleting cross-method slot generators.
- **File**: `src/components/semiconductors/diode.ts:73`
- **Ngspice counterpart**: `ref/ngspice/src/spicelib/devices/dio/diodefs.h:157-158` defines only `DIOcapCharge` + `DIOcapCurrent` (dual-semantic, mode-dependent).
- **Papering language**: (at `diode.ts:655-659`, now under an IMPLEMENTATION FAILURE marker) "our schema does not yet split capd vs capGeq, we use SLOT_CAP_GEQ as the closest analog and flag this as a LATENT divergence".
- **Actual divergence**: digiTS pre-computes `ag[0]*Ctotal` and `Norton-ieq` into state slots; ngspice computes + stamps from local variables. Our slots are write-only vestigial (confirmed by grep — no readers in diode.ts).

### C-AUD-2. LED duplicates the same invented cap slots
**Reconciliation:** BLOCKER → A1 (APPROVED FIX) — same generator collapse as C-AUD-1.
- **File**: `src/components/io/led.ts:166`
- **Actual divergence**: 4-slot schema `SLOT_CAP_GEQ=4, SLOT_CAP_IEQ=5, SLOT_V=6, SLOT_Q=7` copied from diode. Carries the same papering-over.

### C-AUD-3. Tunnel-diode cloned the same invented schema
**Reconciliation:** BLOCKER → F1 (APPROVED ACCEPT) — tunnel-diode frozen as digiTS-only device per F1.
- **File**: `src/components/semiconductors/tunnel-diode.ts:152`
- **Papering language**: `src/solver/analog/__tests__/harness/device-mappings.ts:513` admits "ngspice does not have a dedicated tunnel diode model".
- **Actual divergence**: whole device is digiTS-only — no per-NR parity possible.

### C-AUD-4. Varactor invents `SLOT_CAP_GEQ` / `SLOT_CAP_IEQ` — cross-method read
**Reconciliation:** BLOCKER → A1 + F2 (both APPROVED FIX) — A1 removes cross-method slot pattern; F2 re-instantiates varactor as ngspice diode.
- **File**: `src/components/semiconductors/varactor.ts:110,259-260,315-316`
- **Actual divergence**: read in one method, written in another — cross-method buffering pattern. Not write-only vestigial like diode, but the slots still have no ngspice counterpart.

### C-AUD-5. BJT L1 invents 7 cap slots
**Reconciliation:** BLOCKER → A1 (APPROVED FIX) — generator collapse deletes Norton buffer slots.
- **File**: `src/components/semiconductors/bjt.ts:1321-1327`
- **Ngspice counterpart**: `bjtload.c` computes `capbe`, `capbc`, `capsub` as local variables; only charges go to state.
- **Actual divergence**: `L1_SLOT_CAP_GEQ_BE/BC_INT/BC_EXT/CS` + `_IEQ_*` (7 slots) are digiTS Norton buffers.

### C-AUD-6. MOSFET invents 6 cap slots + 5 Q slots
**Reconciliation:** BLOCKER → A1 (APPROVED FIX) — generator collapse deletes 11 invented slots.
- **File**: `src/solver/analog/fet-base.ts:56-99`
- **Papering language**: `src/solver/analog/__tests__/harness/device-mappings.ts:422` explicitly admits "DB, SB, GB, MEYER, GMBS have no ngspice equivalent".
- **Actual divergence**: `SLOT_CAP_GEQ_GS/GD/DB/SB/GB` + `_IEQ_*` + `SLOT_Q_GS/GD/GB/DB/SB` — 11 slots invented.

### C-AUD-7. BJT L1 store-back writes `CTOT` into `CAP_GEQ` slots
**Reconciliation:** BLOCKER → A1 (APPROVED FIX) — mis-stored slot disappears when cross-method buffer is removed.
- **File**: `src/components/semiconductors/bjt.ts:1875-1881`
- **Ngspice counterpart**: `bjtload.c:676-680` writes `capbe`/`capbc`/`capsub` (transit-time diffusion cap factors).
- **Actual divergence**: downstream code reads wrong values and stamps them as Norton current. V1-critical in `spec/reviews/phase-2-bjt.md`.

### C-AUD-8. MOSFET cap companion regression left as "pre-existing"
**Reconciliation:** BLOCKER → A1 (APPROVED FIX) — root fix via A1 collapse per §2 crosswalk.
- **File**: `src/components/semiconductors/__tests__/mosfet.test.ts:1046-1148`
- **Papering language**: `spec/progress.md` entry for `fix-2.4.mosfet-duplicate-const-mode` — "caused by the wave 2.4.3 useDoubleCap logic change (not by this rename)".
- **Actual divergence**: `SLOT_CAP_IEQ_DB` stores `+0` where ngspice stores `-3.549928774784246e-12`. Real numerical discrepancy admitted and carried forward.

### C-AUD-9. Diode MODEINITSMSIG body empty
**Reconciliation:** BLOCKER → D2 (APPROVED FIX) — D2 populates the diode MODEINITSMSIG body per ngspice dioload.c.
- **File**: `src/components/semiconductors/diode.ts:650-669`
- **Papering language**: "latent divergence noted" in the original comment and in `spec/progress.md` Task 2.4.1.
- **Actual divergence**: ngspice `dioload.c:362-374` writes `capd` then `continue`s (skipping the matrix stamp). Our code falls through and corrupts the AC matrix with companion stamps.

### C-AUD-10. BJT L1 `dt > 0` gate hides MODEINITSMSIG entirely
**Reconciliation:** BLOCKER → D3 (APPROVED FIX) — D3 removes the `dt>0` guard so MODEINITSMSIG reaches BJT L1 code.
- **File**: `src/components/semiconductors/bjt.ts:1789`
- **Actual divergence**: during AC analysis `dt=0`, so the whole store-back is unreachable dead code. V4-critical in `spec/reviews/phase-2-bjt.md:131-149`. ngspice has no `dt > 0` guard on this block.

### C-AUD-11. `_numericLUReusePivots` has no partial-pivoting guard
**Reconciliation:** BLOCKER → B1 (APPROVED FIX) — B1 replaces the absolute threshold with the column-relative ngspice spfactor.c pivot check.
- **File**: `src/solver/analog/sparse-solver.ts:1208-1213`
- **Papering language**: `spec/ngspice-alignment-divergences.md §3-4` frame this as a threshold-constant mismatch.
- **Actual divergence**: ngspice uses column-relative partial-pivot guard (`largestInCol * relThreshold >= diagMag`) per `spfactor.c:218-226`. We use an absolute threshold `1e-13`. These are structurally different algorithms.

### C-AUD-12. Transient-DCOP skips MODEINITTRAN regime via `_firsttime` flag
**Reconciliation:** BLOCKER → C2 (APPROVED FIX) — C2 replaces `_firsttime` with direct `CKTmode = MODEINITTRAN` assignment.
- **File**: `src/solver/analog/analog-engine.ts:422-429`
- **Papering language**: `spec/ngspice-alignment-divergences.md §5`.
- **Actual divergence**: ngspice writes `CKTmode = MODEINITTRAN` directly at `dctran.c:346` inside a single path. We gate on a separate `_firsttime` flag that decouples the decision from the mode.

### C-AUD-13. `dcopFinalize` runs a full NR pass vs ngspice's single `CKTload`
**Reconciliation:** BLOCKER → C1 (APPROVED FIX) — C1 restores single-CKTload dcopFinalize pattern per ngspice.
- **File**: `src/solver/analog/dc-operating-point.ts:222-232` (original pre-Task-2.3.1 code; Task 2.3.1 purports to fix but `_seedFromDcop` still carries legacy mirrors)
- **Papering language**: `spec/ngspice-alignment-divergences.md §2`.
- **Actual divergence**: band-aid commit `d4dc1e3c` papers over the hook-leak caused by the extra NR pass. The real fix is the single-CKTload pattern — but that cascades into other architectural items.

### C-AUD-14. `pnjlim` algorithmically different from `devsup.c:50-58`
**Reconciliation:** BLOCKER → D4 (APPROVED FIX) — D4 adds the Gillespie negative-bias branch per ngspice devsup.c.
- **File**: `src/solver/analog/newton-raphson.ts:89-205`
- **Papering language**: `spec/ngspice-alignment-F6-docs-citations.md` item L2 flags this as "citation divergence".
- **Actual divergence**: ngspice has a Gillespie negative-bias branch we do not implement. Numerical, not citation.

### C-AUD-15. Triode `VGS_JUNCTION` is digiTS internal limiting state
**Reconciliation:** BLOCKER → F3 (APPROVED ACCEPT) — triode frozen as digiTS-only device per F3.
- **File**: `src/solver/analog/__tests__/harness/device-mappings.ts:473`
- **Papering language**: admitted explicitly — "our internal limiting state, not in ngspice state".
- **Actual divergence**: digiTS has no vacuum-tube equivalent in ngspice, so any "parity" claim is aspirational.

---

## Structural items — architectural, user should decide whether to keep or converge

### S-AUD-1. StatePool as cross-method state buffer
**Reconciliation:** BLOCKER → A1 (APPROVED FIX) — A1 is the umbrella fix that collapses this split device-wide.
- **Files**: `src/solver/analog/state-pool.ts`, plus every device's `_updateOp` / `_stampCompanion` split.
- **Ngspice counterpart**: device `load()` computes + stamps in one function using local variables.
- **Actual divergence**: digiTS architectural decision to decouple compute (`_updateOp`) from stamp (`_stampCompanion`) via pool slots. **This is the root cause of the invented-slot problem** (C-AUD-1 through C-AUD-6). Cannot be resolved by slot-level fixes alone.
- **Where it's logged**: `spec/fix-list-phase-2-audit.md` item D-2b — but only as "deferred to Phase 2.5 or 9", which is itself an instance of the papering-over pattern.

### S-AUD-2. `pool.uic` boolean mirror
**Reconciliation:** BLOCKER → A2 (APPROVED FIX) — A2 deletes `pool.uic`; readers consult `cktMode & MODEUIC`.
- **File**: `src/solver/analog/state-pool.ts`; read in `diode.ts:504`, `bjt.ts:820,1520`.
- **Ngspice counterpart**: `(mode & MODETRANOP) && (mode & MODEUIC)` bitfield.
- **Actual divergence**: duplicate storage. Called out V-4 in `spec/reviews/phase-2-diode.md:111-145`.

### S-AUD-3. `statePool.analysisMode = "dcOp" | "tran"` string field
**Reconciliation:** BLOCKER → A3 (APPROVED FIX) — A3 deletes the string field; `CKTmode` bitfield is the sole source.
- **File**: `src/solver/analog/state-pool.ts:19,114`; written at `analog-engine.ts:1193`.
- **Ngspice counterpart**: none — ngspice uses `CKTmode` bitfield only.
- **Actual divergence**: duplicate mode representation. C-2 in fix-list says delete.

### S-AUD-4. `poolBackedElements` + `refreshElementRefs`
**Reconciliation:** BLOCKER → A4 (APPROVED FIX) — A4 deletes the defensive resync list and its refresh callback.
- **File**: `src/solver/analog/ckt-context.ts:286,511`, `src/solver/analog/analog-engine.ts:365,1212`.
- **Ngspice counterpart**: none.
- **Papering language**: `_seedFromDcop` includes `refreshElementRefs` call described as "Kept as a defensive resync" — explicitly a fallback marker.
- **Actual divergence**: digiTS pool-architecture artifact. C-3 in fix-list says delete.

### S-AUD-5. `modelRegistry` + `defaultModel` + `spice-l0`/`l1`/`l2`/`l3` split
**Reconciliation:** BLOCKER → E1 (APPROVED ACCEPT) — framework split is frozen as an accepted digiTS architectural choice.
- **Files**: `src/compile/extract-connectivity.ts:77-97`, `src/headless/netlist-types.ts:84`, `CLAUDE.md` "Component Model Architecture" section.
- **Ngspice counterpart**: one `DEVice` struct per model. No registry, no level/variant split.
- **Actual divergence**: fundamental framework divergence — a digiTS component can simulate under any registered model at runtime; ngspice fixes the model at netlist-parse time. No F-spec addresses this.

### S-AUD-6. `bridge-adapter` + `digital-pin-model` + `BridgeOutputAdapter`/`BridgeInputAdapter`
**Reconciliation:** BLOCKER → E3 (APPROVED ACCEPT) — mixed-signal bridge layer is frozen as accepted digiTS architecture.
- **Files**: `src/solver/analog/bridge-adapter.ts`, `src/solver/analog/digital-pin-model.ts`, `src/solver/coordinator.ts:55-101`.
- **Ngspice counterpart**: none. ngspice has mixed-signal via XSPICE codemodels, but our architecture is entirely different.
- **Papering language**: `spec/plan.md:45` notes "Behavioral-digital element rewrite — not addressed by any F-spec; deferred".
- **Actual divergence**: an entire architectural layer, not a divergence-within-a-device. `deferred` here means "not on the audit radar", which is itself papering-over.

### S-AUD-7. `behavioral-*.ts` family
**Reconciliation:** BLOCKER → E2 (APPROVED ACCEPT) — behavioral-digital family is frozen as accepted digiTS architecture.
- **Files**: `behavioral-flipflop.ts`, `behavioral-gate.ts`, `behavioral-combinational.ts`, `behavioral-sequential.ts`, `behavioral-remaining.ts`.
- **Ngspice counterpart**: none. ngspice has no behavioral-digital layer at all.
- **Actual divergence**: Our C-4 fix (seeding `_prevClockVoltage` in `initState`) invents an ACCEPT-callback substitute — itself a digiTS-specific mechanism.

### S-AUD-8. `cktLoad` takes `iteration` argument
**Reconciliation:** BLOCKER → C3 (APPROVED FIX) — C3 removes the iteration parameter so signature matches ngspice `CKTload(CKTcircuit *)`.
- **File**: `src/solver/analog/ckt-load.ts` (pre-Task-2.2.1; verify F4 fully removed after the audit)
- **Ngspice counterpart**: `CKTload(CKTcircuit *)` takes only the circuit pointer.
- **Papering language**: `spec/ngspice-alignment-verification.md:18` marks this as "PARTIAL — signature divergence real... latent divergence".
- **Actual divergence**: structural, not numerical. Re-labeling as "partial" hides that the signature fundamentally differs.

### S-AUD-9. `_hasPivotOrder` conflates two orthogonal ngspice flags
**Reconciliation:** BLOCKER → B2 (APPROVED FIX) — B2 splits the flag into `Factored` and `NeedsOrdering` per ngspice matrix state.
- **File**: `src/solver/analog/sparse-solver.ts:198`
- **Ngspice counterpart**: ngspice uses separate `Matrix->Factored` + `Matrix->NeedsOrdering` with orthogonal lifecycles.
- **Actual divergence**: one flag covering two state transitions — may cause re-factor decisions to differ.

### S-AUD-10. `preFactorMatrix` snapshot diagnostic
**Reconciliation:** OBSOLETE — §2 crosswalk records no action (policy-OK per plan.md GP6); the audit entry was itself an extension of the papering pattern and has no Track A replacement.
- **File**: `src/solver/analog/sparse-solver.ts`
- **Ngspice counterpart**: none. Policy-sanctioned diagnostic per `plan.md` Governing Principle 6.
- **Note**: this one is defensible; included here because the B-1 fix in the fix-list matters for its correctness (must reflect the factored matrix, not the pre-gmin matrix).

### S-AUD-11. MOSFET sign-inverted voltages (VSB/VBD vs ngspice VBS/VBD)
**Reconciliation:** BLOCKER → G1 (APPROVED FIX) — G1 adopts ngspice MOS1vbs/MOS1vbd sign convention throughout.
- **File**: `src/solver/analog/__tests__/harness/device-mappings.ts:317-331,388-399`
- **Papering language**: "our schema uses VSB (source-bulk), VBD (drain-bulk)", handled via `derivedNgspiceSlots` mapping.
- **Actual divergence**: sign inversion + mapping shim at the harness layer. May work for scalar voltages but is sign-sensitive for derivatives and limiting.

### S-AUD-12. Engine-agnostic / coordinator / mixed-signal bridge layer
**Reconciliation:** BLOCKER → E4 (APPROVED ACCEPT) — coordinator/engine-agnostic layer is frozen as accepted digiTS architecture.
- **Files**: `src/solver/coordinator.ts`, `src/solver/coordinator-types.ts`, `TopLevelBridgeState`, `_resolvedBridgeAdapters`.
- **Ngspice counterpart**: none.
- **Actual divergence**: entire orchestration layer that wraps both backend engines plus bridges. Sanctioned by the CLAUDE.md engine-agnostic hard rule but has implications for per-NR parity.

---

## Possibly misclassified — flag for deeper review

### M-AUD-1. `initSmsig` mode never read by any device before F4 bitfield
**Reconciliation:** BLOCKER → D1 (APPROVED FIX) — D1 wires `"initSmsig"` / `MODEINITSMSIG` into every device's code path.
- **Source**: `spec/ngspice-alignment-divergences.md §7`
- **Framing**: numerical divergence.
- **Reality**: architectural — the `InitMode` type declared the value but zero device files read it. After F4 it moved to `cktMode & MODEINITSMSIG` bitfield. Verify the architectural fix actually landed in every device; the diode MODEINITSMSIG body being empty (C-AUD-9) suggests it did not.

### M-AUD-2. NR ownership of `addDiagonalGmin` / `_needsReorder` invariant
**Reconciliation:** BLOCKER → H2 (APPROVED FIX) — H2 reassigns ownership of `addDiagonalGmin` / `_needsReorder` to the solver per ngspice.
- **Source**: `spec/ngspice-alignment-verification.md §S4`
- **Framing**: "ngspice-same-risk" (numerical).
- **Reality**: structural ownership divergence — in ngspice the solver owns the invariant; in digiTS the NR loop owns it.

### M-AUD-3. `pnjlim` item F6-L2
**Reconciliation:** BLOCKER → D4 (APPROVED FIX) — D4 implements the Gillespie negative-bias branch, reclassifying this away from citation-only.
- **Source**: `spec/ngspice-alignment-F6-docs-citations.md`
- **Framing**: "citation divergence".
- **Reality**: numerical/algorithmic — the Gillespie negative-bias branch is missing.

### M-AUD-4. "Extra diagnostics are permitted divergence" rule
**Reconciliation:** BLOCKER → I1 (APPROVED STRICTER POLICY) — I1 tightens the diagnostics escape hatch and enumerates suppression patterns for removal.
- **Source**: F4 Deliverable 7.
- **Used to justify**: `CKTtroubleNode` mirror, `limitingCollector`, predictor tracer.
- **Audit need**: verify each is actually within the original "diagnostics-only" scope vs quietly broadening the escape hatch.

### M-AUD-5. Sign-inverted MOSFET voltages
**Reconciliation:** BLOCKER → G1 (APPROVED FIX) — G1 adopts ngspice VBS/VBD sign convention end-to-end.
- **Source**: `device-mappings.ts`
- **Framing**: "works by mapping table".
- **Reality**: structural claim that needs bit-exact verification at every sign-sensitive consumer.

### M-AUD-6. `invalidateTopology` trigger parity
**Reconciliation:** BLOCKER → B4 (APPROVED FIX) — B4 traces and aligns the invalidateTopology trigger set against ngspice.
- **Source**: `spec/ngspice-alignment-divergences.md §11`
- **Framing**: "Unknown until call sites are traced".
- **Reality**: self-admitted open item, never closed.

---

## Appendix — confirmed-OK divergences (policy-sanctioned)

These are explicitly permitted by `plan.md` Governing Principle 6 or CLAUDE.md, and are not papering-over:

- **Convergence log / blame tracking / limiting collector** — `newton-raphson.ts`, `capture.ts`, harness.
- **Pre-factor matrix snapshot (as a diagnostic)** — `sparse-solver.ts`. Must reflect the factored matrix, per fix B-1.
- **Engine-agnostic renderer/editor** — CLAUDE.md hard rule; orthogonal to analog-solver correctness.
- **1:1 slot renames** preserving semantics:
  - `SLOT_VD` ↔ `DIOvoltage`
  - `SLOT_VBE` / `SLOT_VBC` ↔ `BJTvbe` / `BJTvbc`
- **`isTranOp` using `!== 0` vs `=== MODETRANOP`** — equivalent for single-bit constant, confirmed in `phase-2-infrastructure.md:419`.
- **Tunnel-diode model existence** — ngspice has no tunnel-diode model; digiTS-only device. Parity question is N/A.
- **`CKTtroubleNode` diagnostic mirror** — `F4 Deliverable 4` — missing diagnostics are banned, extras are permitted.

---

## Key sources

- `spec/ngspice-alignment-divergences.md` — 17 numbered divergences.
- `spec/ngspice-alignment-verification.md` — accuracy grades on those 17.
- `spec/fix-list-phase-2-audit.md` — D-2a / D-2b (the explicit "deferred to Phase 2.5 or 9" that triggered this audit).
- `spec/reviews/phase-2-diode.md` — V-2 / V-3 critical findings on `SLOT_CAP_GEQ`.
- `spec/reviews/phase-2-bjt.md` — V1 / V4 critical findings.
- `spec/reviews/phase-2-mosfet.md` — VIOLATION-1 / 2 on carried-forward regressions.
- `src/components/semiconductors/diode.ts:655-660` — original "closest analog / LATENT divergence" excuse (now under IMPLEMENTATION FAILURE marker).
- `src/solver/analog/__tests__/harness/device-mappings.ts` — harness-level admissions at lines 74, 193, 329, 348, 422, 473, 513.

---

## What to do with this list

The user should decide each cluster separately:

1. **State schema re-alignment** (C-AUD-1 through C-AUD-10, S-AUD-1). The root is S-AUD-1 (StatePool as cross-method buffer). Fixing the root collapses the invented-slot problem for every device at once. Alternative: fix each device's schema individually (diode-first per D-2a in the fix list, then audit the others per D-2b). The second alternative was the deferred plan — that's what triggered this audit.

2. **Solver / convergence algorithm divergences** (C-AUD-11 through C-AUD-14, S-AUD-9, M-AUD-2). Each has a specific ngspice function the digiTS code must be byte-aligned to. Re-implementation is surgical but not small.

3. **Mode / signature cleanup** (S-AUD-2, S-AUD-3, S-AUD-4, S-AUD-8). Deletions + bitfield reads. Straightforward if accepted.

4. **Framework-level decisions** (S-AUD-5, S-AUD-6, S-AUD-7, S-AUD-11, S-AUD-12). These are whole-architecture questions, not device-level fixes. Deciding to keep them means IEEE-754 per-NR-iteration parity with ngspice is unreachable (there's no ngspice "equivalent" to compare against). Deciding to converge them is a multi-phase rewrite.

5. **Misclassification cleanup** (M-AUD-1 through M-AUD-6). Re-label items in `ngspice-alignment-divergences.md` and `ngspice-alignment-verification.md` using the correct category (architectural vs numerical), so future audits don't inherit the same framing.

**All five clusters are out-of-scope for the current fix list — fix-list-phase-2-audit.md covers Phase 2 spec compliance only, not the architectural divergences that predate the F-specs.** The fix list does not claim otherwise; this audit is its companion document.

---

## Reconciliation summary (added 2026-04-21)

**Classification against `spec/architectural-alignment.md` Track A verdicts per §2 crosswalk.**

Every C-AUD / S-AUD / M-AUD item is structural by construction (audit scope) and therefore receives a **BLOCKER** routing to a Track A letter, except one entry the §2 crosswalk explicitly marks as no-action (policy-OK per plan.md GP6). No PARITY tags apply in this doc.

### Routing counts
- BLOCKER items: 32 (routed to Track A)
- OBSOLETE items: 1 (no replacement)
- Total items reconciled: 33 (C-AUD-1..15, S-AUD-1..12, M-AUD-1..6)

### Routing distribution

| Track A ID | Verdict | Items routed here |
|---|---|---|
| A1 | APPROVED FIX | C-AUD-1, C-AUD-2, C-AUD-5, C-AUD-6, C-AUD-7, C-AUD-8, S-AUD-1 |
| A1 + F2 | APPROVED FIX + APPROVED FIX | C-AUD-4 |
| A2 | APPROVED FIX | S-AUD-2 |
| A3 | APPROVED FIX | S-AUD-3 |
| A4 | APPROVED FIX | S-AUD-4 |
| B1 | APPROVED FIX | C-AUD-11 |
| B2 | APPROVED FIX | S-AUD-9 |
| B4 | APPROVED FIX | M-AUD-6 |
| C1 | APPROVED FIX | C-AUD-13 |
| C2 | APPROVED FIX | C-AUD-12 |
| C3 | APPROVED FIX | S-AUD-8 |
| D1 | APPROVED FIX | M-AUD-1 |
| D2 | APPROVED FIX | C-AUD-9 |
| D3 | APPROVED FIX | C-AUD-10 |
| D4 | APPROVED FIX | C-AUD-14, M-AUD-3 |
| E1 | APPROVED ACCEPT | S-AUD-5 |
| E2 | APPROVED ACCEPT | S-AUD-7 |
| E3 | APPROVED ACCEPT | S-AUD-6 |
| E4 | APPROVED ACCEPT | S-AUD-12 |
| F1 | APPROVED ACCEPT | C-AUD-3 |
| F3 | APPROVED ACCEPT | C-AUD-15 |
| G1 | APPROVED FIX | S-AUD-11, M-AUD-5 |
| H2 | APPROVED FIX | M-AUD-2 |
| I1 | APPROVED STRICTER POLICY | M-AUD-4 |
| — (OBSOLETE) | n/a | S-AUD-10 |

A1 is the highest-traffic landing zone with 7 direct items plus 1 compound (C-AUD-4 = A1 + F2); this matches §2's claim that A1 is the generator of the invented-slot problem.
