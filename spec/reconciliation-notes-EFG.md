# Layer 2 Verification Notes — Groups E, F, G

**Date:** 2026-04-21
**Scope:** E-1, E-2, F-1, F-2, G (bundled weak-test section)

---

## Per-item verdicts

### E-1. triac.ts: add MODEINITJCT gate around pnjlim calls

- **L1 tag:** BLOCKER → F4c
- **Verification grep result:**
  - `MODEINITJCT` imported in `triac.ts` → 1 hit (line 41: `import { MODEINITJCT } from "../../solver/analog/ckt-mode.js";`).
  - `if\s*\(\s*ctx\.cktMode\s*&\s*MODEINITJCT` in `triac.ts` → 1 hit at line 302.
- **DONE?:** YES.
- **Current file state:** `src/components/semiconductors/triac.ts` lines 298–316. Inside `load()`: `if (ctx.cktMode & MODEINITJCT) { vmtLimited = vcritMain; vg1Limited = vcritGate; pnjlimLimited = false; } else { /* pnjlim both junctions */ }`. The inline comment at line 303 reads: `// dioload.c:130-136: seed junction voltages directly from vcrit without pnjlim`.
- **I1 violation check:** No save/restore, try/catch, or silent gating. But the comment structurally cites `dioload.c:130-136` as authority for a triac whose Track A verdict is F4c APPROVED ACCEPT — "digiTS-only device, no ngspice equivalent," whose tests are self-compare snapshots per F4 ACCEPT constraint §3 ("No 'equivalent to ngspice X' claims in comments or docs").
- **Verdict:** **PAPERED-RE-OPEN.**
- **Rationale:** This is exactly the papering pattern the task brief flags. The triac is F4c APPROVED ACCEPT as a digiTS-only device with no ngspice counterpart; framing its init as a `dioload.c:130-136` port in an in-code comment violates F4 constraint §3 ("No 'equivalent to ngspice X' claims in comments or docs for ACCEPT items"). The L1 tag already routed this to F4c, so the claim that the gate was added "per ngspice dioload.c" is the papering the reconciliation expected to catch. The gate logic itself may still be wanted as a digiTS-owned design decision, but it must be authored inside F4c's self-compare snapshot design, not as a dioload port, and the comment citing dioload must be stripped.

---

### E-2. led.ts: add MODEINITJCT gate around pnjlim call

- **L1 tag:** BLOCKER → A1
- **Verification grep result:**
  - `MODEINITJCT` in `led.ts` → 2 hits (line 25 import, line 287 guard).
- **DONE?:** YES.
- **Current file state:** `src/components/io/led.ts` lines 279–322 in `load()`. Gate at line 287: `if (ctx.cktMode & MODEINITJCT) { vdRaw = params.OFF ? 0 : vcrit; vdLimited = vdRaw; pnjlimLimited = false; } else { /* pnjlim path */ }`. Comment at 288 cites `dioload.c:133-136`.
- **I1 violation check:** No suppression patterns introduced. Change is an additive gate, not a save/restore or silent catch. The change still lives entirely inside the current `load()` body alongside reads/writes to `SLOT_VD`, `SLOT_ID`, `SLOT_GEQ`, `SLOT_IEQ` — the exact cross-method slots A1 deletes wholesale per §1 ("LED same pair (copied schema)").
- **Verdict:** **OBSOLETE-BY-A1.**
- **Rationale:** A1 §1 explicitly lists LED as sharing the diode `SLOT_CAP_GEQ`/`SLOT_CAP_IEQ` schema that gets deleted; A1 also collapses `_updateOp`/`_stampCompanion` into a single `load()` and re-authors the MODEINITJCT dispatch inline mirroring `dioload.c:129-136` inside the new `load()`. The surgical gate added here is subsumed when A1 rewrites the function. No suppression was introduced, so this is not PAPERED-RE-OPEN — it is simply work that is re-done during A1 execution and does not need standalone carrying.

---

### F-1. Delete historical-provenance comments (handled by relabel agent)

- **L1 tag:** OBSOLETE
- **Verification grep result (from task spec):**
  - `ctx\.isTransient|ctx\.isDcOp|ctx\.isAc|ctx\.isTransientDcop` in any file under `src/` in comments or code → 0 hits in production source for comment-style references (the target pattern "ctx.isTransient appearing in a comment").
  - `cap gate was`, `old gate was`, `was removed` → 0 hits.
  - `VT import removed` in `bjt.ts` (Group A-3 follow-on) → 0 hits.
  - `fallback` in `bjt.ts` (Group A-4 follow-on) → 0 hits.
- **DONE?:** YES (for the listed target file lines).
- **I1 violation check:** No numerical code touched under the comment-sweep label (no stamp formulas, state writes, or gate conditions were altered). The deleted comments did not leave behind new comments containing banned vocabulary ("pre-existing", "workaround", "fallback", "latent", etc.) in the affected files.
- **Verdict:** **ACTUALLY-COMPLETE** (strictly as a comment sweep; does not bypass its L1 OBSOLETE routing).
- **Rationale:** The fix-list text acknowledges this is absorbed by I2 citation/comment hygiene policy after A1/C2 land. The relabel-agent work delivered the sweep it described, zero numerical side-effects, zero banned-word re-introduction. Keeping the L1 OBSOLETE verdict; no re-open needed. Flagging below that this verdict assumes the sweep is truly confined to comment deletions — a spot audit of the commit diff would firm this up.

---

### F-2. Add IMPLEMENTATION FAILURE entries to spec/progress.md (handled by relabel agent)

- **L1 tag:** OBSOLETE
- **Verification grep result:**
  - `IMPLEMENTATION FAILURE` in `spec/progress.md` → 18 hits including:
    - Top-of-file banner at line 3–8.
    - Task 0.1.3 BJT exp(700) clamps entry at line 30.
    - Task 2.4.1 (diode) at line 404.
    - Task 2.4.2 (BJT) at line 330.
    - Task 2.4.3 (MOSFET) at line 366.
    - Task 2.4.7 "MISSING ENTRY" at line 465.
    - Task 2.5.1 (LoadContext test migration) at line 471.
    - Task 2.5.2 (behavioral-flipflop initState) at line 477.
- **DONE?:** YES — all entries listed in the fix-list are present.
- **I1 violation check:** The annotations record divergence honestly; no banned closing verbiage (`tolerance`, `mapping`, `equivalent under`) used as the resolution. The banner at line 3–8 correctly states the remedy is "re-implementation to the F-series specs, not test-weakening and not 'pragmatic' substitution" — consistent with I1 stricter policy. The recorded divergence text does reuse the word "pre-existing" (Task 0.1.3 entry, line 31; line 46) as descriptive framing of a prior failure state; but in context it is immediately followed by "A failing test is not a complete phase regardless of origin label," which flips the banned framing into its condemnation. Not a banned-vocabulary closing-verdict use — acceptable.
- **Verdict:** **ACTUALLY-COMPLETE** (strictly as a bookkeeping sweep; does not bypass its L1 OBSOLETE routing).
- **Rationale:** The bookkeeping pass landed. The L1 OBSOLETE tag stands because after A1 execution the affected waves are rewritten per plan-addendum; the per-task IMPLEMENTATION FAILURE annotations stop being the operative record. No reopen.

---

### G. Weak-test strengthening (bundled)

- **L1 tag:** BLOCKER → A1
- **Verification greps across `src/**/__tests__/*.test.ts`:**
  - `toBeGreaterThan\(0\)` occurrences → 248 total matches across 101 files. (Fix-list target was 17 unpaired occurrences; the 248 includes both paired-with-`toBeCloseTo` and unpaired. No attempt at triage has been made — the bundle has not been exercised at all.)
  - `toBe\("boolean"\)` → 7 hits remaining, including `bjt.test.ts:1277` (`expect(typeof result).toBe("boolean")` — the exact occurrence flagged in the fix-list) and 6 others in scr/mosfet/diode/bjt limiting-event tests.
  - `hasSignificantCurrent` / `maxRhs > 1e-` in `jfet.test.ts` → 3 hits (fix-list flagged 5; unchanged at the flagged level).
  - Arithmetic-identity tautologies in `transmission-line.test.ts` → 4 hits (`expect(2 * (N - 1)).toBe(4)` at line 227; `expect(2 * (10 - 1)).toBe(18)` etc. at lines 301–303). Fix-list flagged 1; unchanged.
  - `Number\.isFinite\(` in test files → 27 hits across 14 files (fix-list flagged 4 as sole assertions; not triaged).
- **DONE?:** NONE. The weak-test section is entirely OPEN. The specific patterns the fix-list called out (unpaired `toBeGreaterThan(0)`, `toBe("boolean")` alone, `hasSignificantCurrent`/`maxRhs > 1e-X`, `expect(N).toBe(N)` tautologies, `expect(2*(N-1)).toBe(…)` arithmetic identities, `Number.isFinite` as sole assertion) are all still present at roughly the reported counts.
- **Per-test findings:** No evidence of harness-derived strengthening for any of the listed patterns. No expected values were hand-computed either — because no strengthening happened. The bundle was not executed in the parallel-agent sweep.
- **I1 violation check:** N/A — no strengthened tests to audit. (Per A1 §Test handling rule, hand-computed strengthenings would automatically be PAPERED-RE-OPEN; this verdict is moot when zero strengthening occurred.)
- **Verdict distribution:** 0 ACTUALLY-COMPLETE / 0 OBSOLETE-BY-A1 / 0 PAPERED-RE-OPEN / full-bundle **OPEN**.
- **Rationale:** Nothing to re-open because nothing closed. The L1 BLOCKER → A1 tag governs how the bundle is handled going forward: each weak test is triaged inside A1 execution against §Test handling rule (delete / migrate-to-harness / keep-as-labeled-survivor). This confirms the L1 routing is operative — the bundle never started independent execution and should not be resurrected as a standalone task.

---

## Summary counts

| Verdict | Count | Items |
|---|---|---|
| ACTUALLY-COMPLETE | 2 | F-1, F-2 (both are comment/bookkeeping sweeps whose L1 OBSOLETE routing remains correct) |
| OBSOLETE-BY-TRACK-A | 1 | E-2 → A1 (LED gate subsumed by A1 `load()` collapse of LED schema) |
| PAPERED-RE-OPEN | 1 | E-1 (triac MODEINITJCT gate framed as a `dioload.c:130-136` port on an F4c APPROVED-ACCEPT digiTS-only device — violates F4 constraint §3) |
| OPEN (never done) | 1 | G (weak-test strengthening bundle — zero measurable progress against the five flagged patterns) |
| **Total** | **4 discrete items + G bundle** | |

---

## Flags for user review

1. **E-1 triac — PAPERED-RE-OPEN evidence.** The in-code comment at `src/components/semiconductors/triac.ts:303` reads:
   `// dioload.c:130-136: seed junction voltages directly from vcrit without pnjlim`.
   Per `spec/architectural-alignment.md` §F4 constraint (ACCEPT items): "No 'equivalent to ngspice X' claims in comments or docs." The triac entry in F4c is `ACCEPT — not a core ngspice device`. The fix-list L1 reconciliation explicitly called this out: "the 'dioload.c pattern' framing is papering architectural independence as an ngspice port." Decision needed: (a) keep the gate behavior but strip the dioload citation and re-comment as self-compare-digiTS behavior, or (b) revert the gate entirely pending F4c self-compare snapshot design. Either way, the current state is not acceptable.

2. **Hand-computed values in G — no such values exist to flag.** Because zero weak-test strengthening happened, there is no hand-computed-expected-value sub-list. If the user intends to land G work later, it must be harness-derived per A1 §Test handling rule.

3. **F-2 banned-word near miss.** `spec/progress.md:31` and `:46` use the phrase "pre-existing" (banned closing verdict). In context both uses are self-condemnations: "A failing test is not a complete phase regardless of origin label." They read as framing, not as closing verdicts on a numerical gap. Flagging for user sanity check that the nuance is acceptable; if not, these two lines should be rewritten to drop the word.

4. **Weak-test pattern counts higher than fix-list baseline.** The fix-list specified 17 unpaired `toBeGreaterThan(0)`, 1 `toBe("boolean")`, 5 `maxRhs`, 3 tautologies, 1 arithmetic identity, 4 `isFinite`. Current raw counts are 248 / 7 / 3 / 3 / 4 / 27 (the first and last are un-triaged and mix paired with unpaired). This is not a regression — the fix-list numbers were the flagged subset, not the total pattern occurrences — but it confirms G work never touched the codebase.

5. **Borderline verdict on F-1.** ACTUALLY-COMPLETE is contingent on the comment sweep truly being comment-only. A spot audit of the relabel-agent diff (commit range around `a4a86ba7`) for any code-side touches would firm the verdict. No `.ts` production-code grep hit was found for the explicit target patterns, so the current evidence supports ACTUALLY-COMPLETE, but I cannot re-run the commit history from inside this verification.
