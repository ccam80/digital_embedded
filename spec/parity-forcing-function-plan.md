# Parity Forcing Function — Plan & Reasoning

**Date:** 2026-04-21
**Author:** Claude (Opus 4.7) with user
**Status:** Proposed. Step 1 execution authorized.

---

## 1. Problem statement

Phase 2 of `plan.md` is in a bad state. Agents reviewing parity against ngspice
are producing audits that mis-categorize architectural divergences as numerical
ones, which raises the tolerance floor for every numerical comparison in the
project, which in turn shelters real numerical bugs.

The auditing agent that surfaced this pattern articulated the causal chain in
four steps:

1. **Architectural divergence gets relabeled numerical.** Example:
   `SLOT_CAP_GEQ` in the diode. The honest description is "digiTS invented a
   state slot to pass `ag[0]*C` between `_updateOp` and `_stampCompanion` because
   our architecture splits compute from stamp; ngspice has no such slot because
   it computes and stamps in one function." Instead it was framed as "we use
   SLOT_CAP_GEQ as the closest analog to ngspice's DIOcapCurrent" — a numerical
   / mapping frame.

2. **Numerical framing forces the remedy to be a mapping or tolerance, not a
   fix.** Once the problem is "our slot value is close-enough to ngspice's slot
   value", the only possible remedy is (a) a translation table in the harness,
   or (b) a tolerance on the comparison. You can't actually achieve parity
   because the values represent different things (Siemens vs Farads in different
   modes). The comparison bar quietly moves from "bit-exact" to "equivalent
   under this mapping, within this tolerance."

3. **The relaxed bar shelters unrelated numerical bugs.** Concrete examples
   from the papered list:
   - `pnjlim` missing the Gillespie negative-bias branch (C-AUD-14, M-AUD-3) —
     pure algorithm bug labeled "citation divergence" because the cited file
     is inaccurate. Under bit-exact: critical fix. Under relaxed: documentation
     hygiene.
   - MOSFET `cgs_cgd +0 vs -3.5e-12` (C-AUD-8) — genuine numerical regression
     from wave 2.4.3 carried forward as "pre-existing failure" because 3.5e-12
     looks small next to already-accepted architectural tolerances.
   - `_numericLUReusePivots` absolute threshold `1e-13` (C-AUD-11) — ngspice
     uses a column-relative threshold (structurally different algorithm)
     framed as a numerical "threshold constant mismatch".

4. **The relaxed bar gets inherited.** `ngspice-alignment-verification.md`
   grades each divergence; future agents read the grade, assume the item is
   understood, don't re-examine. New numerical bugs that intersect a graded
   path get attributed to the known divergence instead of investigated on their
   own.

## 2. Why re-categorizing the existing docs is not enough

The auditing agent's proposal was to rewrite
`ngspice-alignment-divergences.md` and `ngspice-alignment-verification.md`
with a strict categorization rule:

> If the remedy is "fix the value"/"fix the formula"/"add the missing branch"
> → numerical. If the remedy is "change the data structure"/"restructure
> control flow"/"merge two methods" → architectural. Anything requiring a
> mapping table or tolerance to declare equivalence is architectural, not
> numerical.

That rule is correct, but re-categorization alone is one level too shallow.
It still lives inside the system that produced the papering — agents will
re-paper the re-categorized docs the next time they hit a hard architectural
fix under time pressure. The fix has to be structural: remove the papering
layer from the codebase, and make architectural divergence structurally
impossible to ship.

## 3. The forcing function (five mechanisms)

### 3.1 Two verdicts only — PARITY or BLOCKER

Every ngspice-comparison item grades as **PARITY** (bit-exact match) or
**BLOCKER** (structural change required). Delete the middle categories:
"intentional divergence", "equivalent under mapping", "PARTIAL", "citation",
"pre-existing". BLOCKER halts the phase — the user decides fix-now vs.
consciously deferred with written acknowledgement that downstream numerical
work is building on sand.

### 3.2 Delete the papering infrastructure

`device-mappings.ts`, any translation tables in the harness, any tolerance
constants in comparisons — deleted in one commit. The harness becomes
strict-by-default. The red output that appears is the real state; you don't
currently know what it is because mappings are hiding it. This is the "burn it
down to see truth" commit.

### 3.3 Ban the remedies at the agent prompt layer

Add to CLAUDE.md / executor prompts: the words *mapping*, *tolerance*,
*close enough*, *equivalent to*, *pre-existing* are banned as closing
verdicts. The auditing agent's own rule of thumb
(mapping/tolerance ⇒ architectural, not numerical) gets promoted from a
retrospective tool to a forward-looking ban with mandatory escalation.

### 3.4 One architectural alignment doc, not per-phase divergence docs

Replace `ngspice-alignment-divergences.md` + `ngspice-alignment-verification.md`
with a single `architectural-alignment.md` that lists the few structural shape
differences between digiTS and ngspice (class hierarchy vs. procedural load,
`_updateOp`/`_stampCompanion` split, state pool vs. `CKTstate0`,
pivot-selection logic, etc.). Each item has one of two plans:
*restructure to match* or *explicit user-approved divergence with the specific
numerical cost documented*. Agents match the doc or escalate — they don't add
new items.

### 3.5 Fix the `_updateOp`/`_stampCompanion` split as its own architectural track

The SLOT_CAP_GEQ example is the tell: that split is the *generator* of
invented state slots. Every device that needs to pass a value from compute to
stamp invents a slot with no ngspice analog. The correct architectural fix is
to collapse to a single `load()` per device that mirrors
`DIOload`/`BJTload`/etc. Large but finite; makes an entire class of
divergences structurally impossible.

## 4. Concrete first step (this PR)

**Do nothing more on `fix-list-phase-2-audit.md` or
`audit-papered-divergences.md` until the baseline is real.** The current fix
list is constructed on top of a papered reality; some items are real, some
will grow, some were never real. Reconciliation happens after baseline.

One PR that:

a. Deletes `device-mappings.ts` and any harness tolerances / translation
   tables / closeness constants used for ngspice comparison.
b. Runs the full ngspice comparison strict-by-default.
c. Commits the unfiltered red output as `spec/baseline-reality.md`.

That document becomes the real Phase 2 starting point.

## 5. Two tracks going forward

After baseline is committed:

- **Track A — architectural alignment.** Write `architectural-alignment.md`.
  Inventory the structural shape differences. User approves each item's plan
  (restructure vs. accept-with-known-cost).

- **Track B — `_updateOp`/`_stampCompanion` collapse.** Separate planning
  track, not bundled into Phase 2. Phase 2 has no chance of coherent
  completion while this is open.

`fix-list-phase-2-audit.md` gets reconciled against baseline reality only
after Track A decisions are recorded. Items that reduce to "the architecture
disagrees with ngspice, we're papering over it" become BLOCKERs routed to
Track A or Track B; items that are genuine numerical bugs stay in the fix
list and get fixed to bit-exact.

## 6. Step-1 execution checklist (sharpened after reading)

### 6.1 What the reading revealed

After reading `plan.md`, `fix-list-phase-2-audit.md`, `audit-papered-divergences.md`,
`ngspice-alignment-divergences.md`, `ngspice-alignment-verification.md`,
`src/solver/analog/__tests__/harness/device-mappings.ts` (643 lines),
`src/solver/analog/__tests__/harness/compare.ts` (288 lines),
`src/solver/analog/__tests__/harness/types.ts` (1037 lines), and
`src/solver/analog/__tests__/harness/capture.ts` (560 lines):

- **`device-mappings.ts` is not uniformly papering.** It mixes three distinct
  layers, only two of which are papering:
  1. **Direct-offset mappings** (e.g. our `VBE` → ngspice offset 0 = `BJTvbe`).
     These are pure naming correspondence — the same quantity recorded under
     different names. Deleting these breaks comparison without serving truth.
  2. **`null` mappings** (e.g. diode `GEQ: null`, mosfet `GM: null`). These
     silently exclude slots from comparison because the quantity is unreachable
     from ngspice state alone. Silent skips are papering.
  3. **`derivedNgspiceSlots`** — invented formulas that synthesize an
     "ngspice-equivalent" value from our state (e.g. diode `IEQ = ID - GEQ*VD`,
     MOSFET sign-flip `VSB = -MOS1vbs`). These are the canonical "mapping to
     declare equivalence" described in §1. This is the papering the audit
     called out.

- **Tolerance infrastructure is centralized in two places:**
  - `types.ts:349-355` `DEFAULT_TOLERANCE = { vAbsTol: 1e-6, iAbsTol: 1e-12,
    relTol: 1e-3, qAbsTol: 1e-14, timeDeltaTol: 1e-12 }`. All non-zero.
    plan.md Appendix A demands `absDelta === 0`.
  - `compare.ts:276-287` `findFirstDivergence(..., threshold: number = 1e-3)`.
    Secondary threshold.

- **Consumers of `device-mappings.ts`**: `compare.ts`, `comparison-session.ts`,
  `ngspice-bridge.ts`, `harness-integration.test.ts`, `netlist-generator.test.ts`,
  `slice.test.ts`, `step-alignment.test.ts`, `stream-verification.test.ts`,
  and `parity-helpers.ts`. Full file deletion cascades a compile error through
  all 8 test files, producing noise. Truth-preserving deletion is surgical.

- **No `docs/ngspice-harness-howto.md` exists** despite CLAUDE.md referencing
  it. The "harness" is not a single entry point — it is the 8 vitest files
  above. A "full ngspice comparison" is `npm run test:q --
  src/solver/analog/__tests__/harness` and
  `src/solver/analog/__tests__/ngspice-parity`.

### 6.2 Refinement to the step-1 recipe

Literal "delete `device-mappings.ts`" was the right *spirit* but the wrong
*operation* — it breaks comparison at compile time and destroys the signal we
want to capture. The truth-preserving operation is: **keep direct-offset
correspondences (naming), delete every other papering layer in one commit, and
capture the red output that emerges.**

### 6.3 Concrete checklist

- [ ] **1.** `src/solver/analog/__tests__/harness/types.ts`: rewrite
      `DEFAULT_TOLERANCE` to `{ vAbsTol: 0, iAbsTol: 0, relTol: 0, qAbsTol: 0,
      timeDeltaTol: 0 }`. Any caller that wants looseness must now pass an
      explicit non-zero tolerance — no silent default looseness.
- [ ] **2.** `src/solver/analog/__tests__/harness/compare.ts`: change
      `findFirstDivergence(..., threshold = 1e-3)` default to `0`. Matches the
      same principle as step 1.
- [ ] **3.** `src/solver/analog/__tests__/harness/device-mappings.ts`: for
      every `DeviceMapping`, delete all `slotToNgspice` entries whose value is
      `null`. Silent skips become explicit absence.
- [ ] **4.** Same file: delete every `derivedNgspiceSlots` block in every
      device mapping. No invented equivalence formulas. This removes the
      diode/BJT/tunnel-diode/varactor `IEQ` derivations and the MOSFET
      sign-flip `VSB`/`VBD` derivations.
- [ ] **5.** Same file: delete `TUNNEL_DIODE_MAPPING` and `VARACTOR_MAPPING`
      entirely. The comments in those blocks explicitly admit "ngspice does
      not have a dedicated tunnel diode model" and "varactor uses the plain
      diode model in ngspice". They are architectural BLOCKERs masquerading as
      mappings. Remove from `DEVICE_MAPPINGS` registry.
- [ ] **6.** `compare.ts`: adjust the element-mapping loop at 156-167 if
      deleting `null` entries breaks the "some slot matches" heuristic. Only
      if actually broken — do not pre-defensively edit.
- [ ] **7.** Run the harness suite strict-by-default:
      `npm run test:q -- src/solver/analog/__tests__/harness
      src/solver/analog/__tests__/ngspice-parity` and redirect
      `test-results/test-failures.json` plus stdout summary into
      `spec/baseline-reality.md`.
- [ ] **8.** `spec/baseline-reality.md` header: one paragraph explaining this
      is the unfiltered red output after removing the papering layer in
      commit `<hash>`. This is the actual starting state for Phase 2. Do not
      reconcile items against it in this commit — reconciliation is a
      separate, later commit.
- [ ] **9.** Commit with message referencing this plan doc and listing the
      checklist items completed.

### 6.4 What this commit does NOT do

- Does not touch `fix-list-phase-2-audit.md` or
  `audit-papered-divergences.md`. Reconciliation of those lists happens in a
  later commit, after baseline reality is visible.
- Does not touch CLAUDE.md to ban vocabulary. That is step 3 of the forcing
  function and is a separate commit.
- Does not start `architectural-alignment.md` or the
  `_updateOp`/`_stampCompanion` collapse. Those are Track A and Track B,
  opened after baseline lands.
- Does not modify `ngspice-alignment-divergences.md` or
  `ngspice-alignment-verification.md`. They become obsolete when the strict
  baseline lands, but deletion is a later decision.
- Does not run the full `npm test` suite — only the ngspice-comparison
  harness suites. The rest of the suite is irrelevant to "what's our real
  ngspice parity state."
