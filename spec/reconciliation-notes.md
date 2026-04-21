# Reconciliation Layer 2 Verification — Summary

**Date:** 2026-04-21
**Protocol:** `spec/reconciliation-task.md` §Layer 2
**Scope:** 39 fix-list items (A-1..A-4, B-1..B-4, C-1..C-10, D-1..D-15 incl. D-2a/2b, E-1..E-2, F-1..F-2, G weak-test bundle)
**Source of truth:** `spec/fix-list-phase-2-audit.md` (Layer 1 tags), `spec/architectural-alignment.md` (Track A verdicts)

Per-group verdict files:
- `spec/reconciliation-notes-AB.md` — Groups A + B (Phase 0 + Phase 1 sparse solver)
- `spec/reconciliation-notes-C.md` — Group C (Phase 2 infrastructure)
- `spec/reconciliation-notes-D.md` — Group D (Phase 2 device loads)
- `spec/reconciliation-notes-EFG.md` — Groups E + F + G (remaining devices, test migration, weak-test bundle)

---

## 1. Consolidated verdict counts

| Verdict | Count | Items |
|---|---:|---|
| **ACTUALLY-COMPLETE** | 15 | A-1, A-2, A-3, A-4, B-2, C-4, C-5, C-7, D-1, D-3, D-5, D-8 (canary), D-15, F-1, F-2 |
| **OBSOLETE-BY-TRACK-A** | 20 | B-1 → B3; B-3 → C2; B-4 → B1; C-1, C-6, C-9, C-10 → C2; C-2, C-8 → A3; C-3 → A4; D-2a, D-2b, D-4, D-7, D-9, D-10, D-11, D-12 → A1; D-6 → A2 (via A1 BJT rewrite); E-2 → A1 |
| **PAPERED-RE-OPEN** | **3** | D-13, D-14, E-1 |
| **OPEN (never done)** | 1 | G weak-test bundle |
| **Total** | 39 | |

## 2. PAPERED-RE-OPEN (reverts to work list)

These items' "completions" violate A1 §Test handling rule or F4 ACCEPT framing. They go back to the work list and get re-addressed during A1 execution or before.

### D-13 — capacitor test `stampCompanion_uses_s1_charge_when_initPred`
- **What happened:** the "completion" swapped one hand-computed expected value (`-7`) for another (`-3`).
- **Why papered:** both values are hand-computed from inspection of invented `SLOT_GEQ` / `SLOT_IEQ` pool slots that A1 deletes wholesale. Textbook A1 §Test handling rule violation — the test asserts against intermediate state between `_updateOp` and `_stampCompanion`, and its expected value never came from ngspice.
- **Remedy during A1 execution:** delete the test. A post-A1 equivalent (if needed) comes from the ngspice harness, not hand computation.

### D-14 — inductor test `stamps branch incidence and conductance entries`
- **What happened:** hand-computed stamp count changed `4 → 5`.
- **Why papered:** `stamps.length` is a digiTS-only capture mechanism not exposed by ngspice. The "correct" count cannot be derived from ngspice; it is a digiTS-internal structural assertion.
- **Remedy during A1 execution:** delete the test or reframe against observable post-A1 behavior (matrix stamp effect, not stamp call count).

### E-1 — triac MODEINITJCT gate
- **What happened:** `src/components/semiconductors/triac.ts:303` carries the comment `// dioload.c:130-136: seed junction voltages directly from vcrit without pnjlim`.
- **Why papered:** triac is F4c **APPROVED ACCEPT** — digiTS-only device with no ngspice counterpart. F4 constraint §3 forbids "equivalent to ngspice X" claims in comments for ACCEPT items. Citing `dioload.c` frames triac as an ngspice port, which is exactly the papering-digiTS-as-ngspice pattern the forcing function targets.
- **Remedy:** strip the `dioload.c:130-136` citation from the comment. If the gate itself was only justified by the port framing, revert the gate as well. The functional change (if any) is evaluated on its own digiTS-owned merits, not as an ngspice port.

## 3. OPEN (never done)

### G — weak-test strengthening bundle
- **What happened:** zero measurable progress. None of the 248+ flagged patterns (unpaired `toBeGreaterThan(0)`, `toBe("boolean")` sole assertions, `Number.isFinite` sole assertions, etc.) exhibit harness-derived strengthening.
- **Routing:** BLOCKER → A1 per Layer 1. Each weak test is triaged inside A1 execution under §Test handling rule (keep if harness-derived, delete if hand-computed, delete if inspecting disappeared intermediate state).

## 4. Items flagged for user review — RULED 2026-04-21

User accepted all six recommendations (Option A on each): **don't do pre-A1 audit/cleanup work that A1 will naturally handle.**

### 4.1 D-8 canary ruling — **ACCEPTED (Option A)**
- **Status:** MOSFET `cgs_cgd +0 vs -3.5e-12` regression still exists in current code.
- **Ruling:** canary framing confirmed. D-8 is tracked as a PARITY item; the regression is measured post-A1 against the rewritten MOSFET `load()`. If bit-exact, D-8 silently closes. If not, D-8 becomes a post-A1 PARITY ticket against the new structure. **No pre-A1 fix against the current split architecture.**

### 4.2 D-2a `return` vs `continue` — **ACCEPTED (Option A)**
- **Ruling:** architectural-by-construction under A1. The `return` in digiTS's device methods is the structural equivalent of ngspice's `continue` inside `cktload.c`'s outer loop. Not a separate item; A1's rewrite produces the appropriate loop/method structure naturally.

### 4.3 C-6 / C-10 `InitMode` string — **ACCEPTED (Option A)**
- **Ruling:** delete `InitMode` everywhere — production AND harness. Harness diagnostics use a `bitsToName(cktMode)` helper that takes the integer and returns a readable name ("MODEINITJCT", etc.). One type system, no parallel `InitMode` drift. C2 execution sweeps both production and harness.

### 4.4 F-2 "pre-existing" in progress.md:31, 46 — **ACCEPTED (Option A)**
- **Ruling:** leave as-is. The banned-vocabulary rule targets closing verdicts on current divergences; progress.md:31/46 is historical self-condemnation documenting a past IMPLEMENTATION FAILURE. The two occurrences are the audit trail for why the ban exists and stripping them would erase the evidence.

### 4.5 F-1 comment sweep — **ACCEPTED (Option A)**
- **Ruling:** no spot-commit audit. A1 rewrites the relevant device-load files wholesale; any stray numerical drift gets overwritten. Verdict stands as ACTUALLY-COMPLETE without back-fill verification.

### 4.6 ngspice citations for D-4..D-8 — **ACCEPTED (Option A)**
- **Ruling:** no pre-A1 back-fill of individual citation reads. A1 executors read the full `bjtload.c` and `mos1load.c` load functions end-to-end during the port; any miscited line range gets caught and corrected in the A1 patch. No separate pre-A1 citation audit.

## 5. What this means for the next phase

- **Reconciliation is complete.** All 4 layers have deliverables. All 39 fix-list items have verdicts. 33 audit-papered-divergences items have routings. 98 plan.md sub-tasks have mappings. ~44 I1 suppression sites + one 852-site wholesale sweep category enumerated.
- **Net genuine remaining PARITY work:** 7 items (A-1, A-2, C-4, C-5, D-1, D-8, D-15) — all deferred to post-A1 execution or handled inside A1 naturally.
- **Net genuine remaining OPEN work:** 3 items (D-13, D-14, E-1 — all A1-execution scope) + G bundle (A1-execution scope).
- **The entire work list now reduces to: execute Track A as Phase 2.5, then run a post-A1 reconciliation pass that picks up the 7 PARITY items + 3 re-opened PAPERED items against the rewritten codebase.**

## 6. Sign-off

- Layers 1, 3, 4 → delivered (see `spec/fix-list-phase-2-audit.md`, `spec/audit-papered-divergences.md`, `spec/plan-addendum.md`, `spec/i1-suppression-backlog.md`).
- Layer 2 → delivered (this file + 4 per-group files).
- **Reconciliation task complete.** Next action: begin Phase 2.5 (Track A execution) once the 6 user-review flags in §4 are ruled.
