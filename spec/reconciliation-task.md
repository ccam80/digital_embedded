# Reconciliation Task — Scope After Track A Approval

**Date:** 2026-04-21
**Status:** Task specification. Not yet started.
**Inputs:**
- `spec/architectural-alignment.md` (all 30 items APPROVED)
- `spec/fix-list-phase-2-audit.md` (~65 items, ~35 marked done + ~30 open)
- `spec/audit-papered-divergences.md` (~38 items)
- `spec/plan.md` (Phase 0–9 execution plan, phases 1–2 substantially done)
- `spec/baseline-reality.md` (post-papering-removal test state)

**Output:** a clean, trustworthy work list for post-Track-A execution.
**Expected effort:** ~1–2 days of focused document work + code reading.
No runtime code changes in this task.

---

## What "reconciliation" now means

Originally framed as re-classifying fix-list items against Track A
verdicts. Scope has grown after plan.md review — Track A collides with
plan.md Phases 3 / 5 / 6 / 7 in ways that the fix-list alone doesn't
capture. Reconciliation now has **four layers**.

### Layer 1 — Fix-list + audit-divergences classification (fast)

Walk `fix-list-phase-2-audit.md` and `audit-papered-divergences.md` item
by item. Tag each with one of three labels against
`architectural-alignment.md`:

- **PARITY** — genuine numerical bug. Stays in the fix-list. Still
  needs fixing bit-exact against an ngspice source.
- **BLOCKER** — item is actually architectural. Route to its Track A
  letter (A1 / B3 / C1 etc.). Remove from fix-list.
- **OBSOLETE** — item was itself papering over a divergence A1 or
  similar now deletes. Remove entirely.

Use §2 crosswalk in `architectural-alignment.md` as the primary lookup.
Most items map directly.

**Deliverable:** `fix-list-phase-2-audit.md` with each item tagged; a
terminal section deleting the OBSOLETE items (keep their commit history
by not rewriting already-landed commits).

### Layer 2 — Verify the 35 "already done" fix-list completions

For every item in the fix-list marked DONE (from parallel-agent work
that landed in commit `a4a86ba7` "starting state for Track A"):

1. Read the specific commit(s) that closed it (cite in reconciliation
   notes).
2. Check: did the commit cite an ngspice source as authority?
3. Check: does the change match that ngspice source bit-exact, or is
   it a hand-computed value?
4. Check: does the change introduce any I1 violation (save/restore,
   silent catch, "suppress spurious X" gate, test asserting a
   hand-computed expected value)?
5. Classify as one of:
   - **Actually complete** — PARITY confirmed, keep as done.
   - **Structurally OBSOLETE** — fix operated on a slot or interface
     A1 deletes; the commit becomes unreachable dead code that A1
     removes naturally. Mark as covered-by-A1.
   - **Papered completion** — test-chasing fix, hand-computed value,
     or suppression-introducing change. Reverts to OPEN. Item returns
     to the work list.

This is the layer that catches silent papered completions. Without it,
those "done" commits carry forward into Phase 5/6/7 work under the
false assumption that the underlying parity is real.

**Deliverable:** a per-commit verification table in
`spec/reconciliation-notes.md`, with a final summary count: X actually
complete, Y OBSOLETE-by-A1, Z papered-re-open.

Delegate-able to a verifier agent under a strict prompt.

### Layer 3 — plan.md addendum (map every remaining plan task)

For every *remaining* (not done) task in `spec/plan.md` Phases 2–9, tag
against Track A verdicts:

- **CARRY AS-IS** — task continues per its current spec text
  unchanged. Still correct under the Track A architecture.
- **SATISFIED-BY** — task is subsumed by an already-done Track A item
  (or will be after A1 execution). Cite the Track A item. Task removed
  from plan.md.
- **PAUSE-UNTIL-A1** — task structurally depends on the
  `_updateOp`/`_stampCompanion` split. Frozen until A1 execution lands.
- **REWRITE POST-A1** — task re-authored against the `load()` structure
  after A1 lands. Keep the intent (algorithm to align); drop the
  line/block-specific surgical instructions.

**Expected classification pattern** (not yet verified):
- Phase 1 (done): most waves SATISFIED-BY Track A B1–B4.
- Phase 2 (in-flight): Wave 2.3 SATISFIED-BY C1/C2; Wave 2.4 PAUSE
  (re-laid-out by A1); Wave 2.2 SATISFIED-BY C3.
- Phase 3: 3.1 CARRY (B5); 3.2 PAUSE (xfact lives inside A1's `load()`);
  3.3 mostly SATISFIED-BY C2.
- Phase 4: 4.2.1 SATISFIED-BY D4; 4.3.1 SATISFIED-BY H1; rest CARRY or
  fold into A1 execution.
- Phase 5 / 6 / 7: every task PAUSE. Re-authored post-A1 against
  `load()` architecture; many will consolidate or disappear because
  A1's load() structure already handles the concern.
- Phase 8: Wave 8.1.2 OBSOLETE (updates `ngspice-alignment-
  divergences.md`, which is now superseded). Wave 8.1.3 CARRY (citation
  audit maps to Track A I2).
- Phase 9: CARRY with expanded identifier list (add A1/A2/A3/A4 deleted
  identifiers to the grep target set).

**Deliverable:** a new `spec/plan-addendum.md` with the full mapping
table. Once produced, the dependency graph in plan.md gets one new node
inserted between Phase 2 and Phase 3:

```
Phase 2 (F3+F4 cktMode + LoadContext)      ─── in flight
  │
Phase 2.5 (Track A execution)              ─── NEW
  ├── A1 collapse _updateOp/_stampCompanion (umbrella, every device)
  ├── A2 delete pool.uic
  ├── A3 delete statePool.analysisMode
  ├── A4 delete poolBackedElements + refreshElementRefs
  ├── F2 varactor → diode instantiation
  ├── F4a/F4b device parity (15 devices, ngspice primitive or composition)
  ├── F4c harness exclusions (15 digiTS-only devices)
  ├── G1 MOSFET sign convention
  └── I1 enumerate and remove suppression patterns
  │
Phase 3 (F2 NR reorder + predictor)        ─── rewrite post-A1
Phase 5/6/7 (F-BJT / F-MOS / F5ext-JFET)   ─── rewrite post-A1
```

### Layer 4 — Suppression enumeration (I1 backlog)

Per I1 stricter policy, enumerate every existing suppression pattern in
the codebase for removal during Phase 2.5 A1 execution.

Search surface:
- `save[A-Z]\w* = .*;` followed later by `.* = save[A-Z]\w*` — save/
  restore pairs.
- `try { ... } catch (.*) { }` — silent catches.
- `try { ... } catch { (log-only at debug level) }` — filtered catches.
- `if (.*spurious.*)` / `if (.*expected.*)` — suppression gates.
- `// @ts-expect-error` without a linked issue.
- Test `skip` / `todo` annotations without a linked APPROVED ACCEPT
  reference in `architectural-alignment.md`.
- Test assertions with a hand-computed expected value (this is per A1's
  test-handling rule, but has overlap with I1 — a test encoding a
  divergence as expected state is a form of suppression at the test
  layer).

**Deliverable:** `spec/i1-suppression-backlog.md` with one row per
found pattern: file, line, pattern, proposed removal approach. Rows are
worked during A1 execution (most will fall out naturally as the
generator is fixed).

---

## Dependency order

Layers are independent in principle but have a natural order:

1. **Layer 1** first (fast, mechanical). Gives the clean work-list.
2. **Layer 3** next (plan.md mapping). Needed before A1 execution
   begins so the execution track knows what phases to rewrite after.
3. **Layer 2** and **Layer 4** in parallel (can delegate to verifier
   agents). Neither blocks A1 execution — their output informs the
   execution but the umbrella A1 fix happens regardless.

Reconciliation is complete when all four deliverables exist and are
committed.

---

## What reconciliation does NOT do

- No code changes. Zero. If a commit changes a `.ts` file, it is not
  reconciliation; it is execution.
- No new Track A items. Agents do not add items to
  `architectural-alignment.md` — that is a user action per the
  forcing function.
- No re-grading of architectural-alignment.md items. All are APPROVED;
  reconciliation reads them, does not modify them.
- No full test runs. Reconciliation is document work; execution runs
  the tests.

---

## Post-reconciliation flow

```
Reconciliation complete
  │
Phase 2.5 — Track A execution (single atomic push)
  │  A1 umbrella + A2-A4 + F2 + F4a/F4b execution + G1 + I1 cleanup
  │
Phase 5/6/7 rewrite against post-A1 architecture
  │  Plan-addendum table says which tasks still exist and in what shape
  │
Phase 3 rewrite post-A1 (if any tasks survived)
  │
Phases 8 / 9 run per original plan
  │
Out-of-plan acceptance: 8-circuit bit-exact ngspice parity harness
```

Track B (originally `_updateOp`/`_stampCompanion` collapse) was folded
into A1 during Track A design. No separate track remains.
