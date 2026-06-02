# v41 Port — Verifier Contract

This governs the agent that **verifies** the v41 port. The applier works from
`TASK.md`. The verifier and applier are **never the same context** — review is
a separate pass (OMC rule: no self-approval). The verifier is the only role
that may set an item to `APPLIED`.

---

## 1. What you verify

For each `functionGroup` the applier marked **ready for verification**, you
decide whether our TypeScript is now a faithful port of the **v41** ngspice
function — above the level of an identifier rename and C↔TS syntax.

You do **not** run tests to decide this. Tests are triaged in a separate phase
(some break, some start passing — both expected). A passing test is not
evidence of a correct port; a failing test is not evidence of an incorrect
one. Your evidence is the source, only.

## 1a. The harness gate — reconstruction items and device completion

The source-only rule in §1 applies to verifying a **single diff hunk**. It is
**necessary but not sufficient** for two larger units of work:

- a **reconstruction item** (a whole subsystem built from a spec, e.g.
  `ind#recon/modelParams`), and
- **device completion** (the point at which every hunk for a device is
  `APPLIED`).

For these two, source isomorphism alone **cannot** establish correctness,
because the most damaging class of divergence is invisible to source review:
**per-device `load()` accumulation order on shared nodes and the compiler's
node-index allocation order** (per CLAUDE.md "Sparse Solver is Settled"). These
are emergent properties of how multiple devices interact — no single function
or hunk is "wrong" when you read it, yet the assembled solve diverges. The
signature is a **bit-identical matrix + RHS at iter 0 with a divergent solved
value**; the cause is upstream of the solver, in load/compiler ordering.

Therefore a reconstruction item or a device is `APPLIED` only when, in
addition to source isomorphism, the **harness reports `firstDivergence` null
across all four signal classes (voltage, matrix, state, shape) on every
targeted circuit** for that device. Run `harness_start` → `harness_run` →
`harness_first_divergence` against the device's representative `.dts`
fixtures. A null `firstDivergence` is the gate.

A **non-null `firstDivergence` is a real divergence and blocks `APPLIED`.** You
may **not** wave it through as "Class A", "re-baseline later", "settled-solver
roundoff", "downstream round-off", or "pre-existing". Per CLAUDE.md these are
banned closing verdicts. Classify it — bit-identical matrix+RHS points at
load/compiler accumulation order, not the solver — and either the applier
fixes it to bit-exact, or it is escalated to `spec/fix-list-phase-2-audit.md`
(numerical bug) with the harness evidence (step, iter, node, absDelta, and the
`matrix_diff` verdict). "It existed before this change" does not make it
acceptable; it makes it a tracked fix-list item, never a closed one.

## 2. Two-tier check

### Tier 1 — per-hunk diff isomorphism

For each hunk in the group:

1. `Read` the hunk from its `diffDoc` at `docLineRange`. If the item is a
   **sub-item** of a split hunk (`isSubItem: true`, suffixed `id`), its
   `docLineRange` is only its slice — verify against that slice alone; the
   other sub-items of the same parent are separate ledger items.
2. Obtain our delta for that hunk: `git diff` of the applier's edit to
   `files[].tsFile`, restricted to the corresponding region.
3. Confirm the two deltas are **line-isomorphic**: the ngspice hunk's `-`
   lines map one-to-one onto our removed lines, its `+` lines map one-to-one
   onto our added lines, **same positions, same order**.
4. **The zero-delta rule.** If our delta is empty, it is line-isomorphic to
   the hunk **only if every `+` and `-` line of the ngspice hunk is itself an
   allowed difference (§4)** — an identifier rename, C↔TS syntax, or a comment.
   If the hunk has any `+`/`-` line that is a real change — a new statement, a
   new branch, changed arithmetic, changed control flow — and our delta is
   empty, the change has been **dropped**: `MISMATCH`. An empty delta is never
   waved through on the ground that "digiTS already achieves the effect".

This catches under-application (a hunk line absent from our delta),
over-application (our delta touches what the hunk did not), and re-ordering.

### Tier 2 — per-function structural identity (bijective construct coverage)

Once **all** hunks in a `functionGroup` pass Tier 1, verify the whole method
against the **v41** ngspice function, read fresh from `ref/ngspice/`.

Build a **construct-by-construct correspondence** between v41's function and
ours — every statement, branch, loop, and assignment. The correspondence must
be **bijective**:

- **every v41 construct maps to a digiTS construct**, and
- **every digiTS construct maps to a v41 construct.**

For each matched pair, confirm: arithmetic expressions have the same operands,
operators, order, and grouping; branches have the same condition, structure,
and nesting; loops match; the set of functions and their boundaries matches.

A **v41 construct with no digiTS counterpart is an automatic fail.** You may
**not** pass it by arguing our simpler structure achieves the same result.
"digiTS already achieves this", "digiTS structurally never had the defect",
"the post-change behaviour is already present" are the **banned
semantic-equivalence verdict** — reaching for one is itself a verification
failure. A v41 construct with no digiTS counterpart is `MISMATCH` (the applier
ports it) or `ESCALATE` (if the gap reflects an architectural divergence the
user must rule on — e.g. digiTS's model omits a sub-feature ngspice has). A
digiTS construct with no v41 counterpart is likewise `MISMATCH` or `ESCALATE`.

Tier 2 also catches a **bad v26 baseline** — a function where every hunk
applied correctly but our pre-edit code did not match v26, so the result still
does not match v41. Tier 1 alone cannot catch this.

## 3. Derive equivalence independently

Do **not** consume the applier's `rename-maps/<file>.md`. Re-derive the
ngspice → digiTS identifier correspondence yourself from the two sources. If
the applier and you independently agree the code matches, the renaming was
consistent. If you must assume a rename the applier's map asserts and you
cannot independently justify it from the code, that is a **MISMATCH**, not a
pass. This closes the "both sides trusted the same wrong map" hole.

Always read the v41 source from `ref/ngspice/<ngspiceFile>` directly — never
trust the diff markdown as your only view of v41.

## 4. Allowed vs forbidden differences

**Allowed** (a `MATCH` may still hold):

- identifier names;
- C↔TS syntax: `->` vs `.`, pointer dereference, `double` vs `number`,
  typed-array indexing vs C array indexing, `for`/`while`/`if` surface form,
  brace and whitespace style;
- comment wording.

**Forbidden** (any one → `MISMATCH`):

- reordered operands in an arithmetic expression;
- a subexpression factored out or inlined relative to v41;
- statements merged or split relative to v41;
- algebraic simplification;
- different branch/loop nesting;
- a helper that v41 does not have, or two v41 functions merged into one
  (violates "function grouping identical");
- a v41 added/deleted/split function not mirrored in our methods.

## 5. Verdict

Per group, emit exactly one verdict.

- **`MATCH`** — every hunk passed Tier 1 and the function passed Tier 2. For a
  **reconstruction item** or at **device completion**, the §1a harness gate
  must also hold (`firstDivergence` null on every targeted circuit) — a
  non-null divergence blocks `MATCH` regardless of source isomorphism. For
  every hunk in the group, write an entry to `spec/v41-port/progress.json`:
  `state = "APPLIED"`, the item's current `hunkHash`, and one-line evidence in
  `verifierNotes` (the v41 file:line range you compared against). You `Edit`
  `progress.json`, never `ledger.json`. Then run
  `node spec/v41-port/build-ledger.mjs` — it validates your entries and
  composes `ledger.json`.

- **`MISMATCH`** — at least one specific, named divergence. Leave the affected
  hunks `PENDING` (write no `state`). In each affected hunk's `progress.json`
  entry, append to `verifierNotes` a note that states **the exact divergence**:
  the ngspice file:line, our file:line, and what differs (which operand, which
  branch, which statement). A note like "does not match" is not acceptable —
  the applier's next attempt needs a precise target. The applier increments
  `attempts`.

- **`ESCALATE`** — see §6.

`MATCH` requires the **bijective** construct correspondence of Tier 2 — every
construct on both sides accounted for. Anything short of that is `MISMATCH` or
`ESCALATE`, never `MATCH`. If our code differs from v41 and you cannot name a
precise `MISMATCH`, and cannot confirm a clean `MATCH` — if the honest state
is "they differ and I am unsure whether that is acceptable" — that uncertainty
**is an `ESCALATE`**. There is no benefit of the doubt.

You never emit "equivalent", "within tolerance", "close enough",
"pre-existing", "partial", or "good enough". Per `CLAUDE.md` these are banned
as closing verdicts. It is `MATCH`, a specifically-named `MISMATCH`, or
`ESCALATE`.

## 6. Escalation from the verifier

Write the item an `ESCALATED` entry in `spec/v41-port/progress.json` (state
`"ESCALATED"`, the `escalation` object, the item's current `hunkHash`) when:

- **Bad v26 baseline (Tier 2):** the applier found our pre-edit baseline did not
  match v26 and (per `TASK.md` §6) ported the **whole function to v41** rather than
  applying a delta. Verify it the normal Tier-2 way — bijective match to fresh v41
  source. If it matches → `APPLIED` (keep the applier's `BASELINE-DIVERGENCE:`
  note; that is the audit record, no escalation needed). **Escalate only** if the
  function still does not match v41 because matching needs a change *beyond the
  `functionGroup`* or a feature digiTS's model lacks — name the function, the
  divergent region, and the v41 target. An in-group rewrite to v41 is not an
  escalation; only an out-of-group / feature gap is the user's call.

- **Auto-escalate on spin:** an item reaching `attempts >= 3` (third rejection)
  is not mechanically applicable by the loop. Escalate it with the full
  `verifierNotes` history so the user can see why each attempt failed.

- **Cross-group architecture change:** applying the v41 change correctly
  requires an architecture change whose blast radius extends *beyond the
  current `functionGroup`*, or a genuine C→TS ambiguity. An architecture
  change **contained within** the functionGroup is **not** an escalation — it
  is the applier's job per `TASK.md` §2. There is no "accepted divergence"
  outcome in this job; an escalation blocks job completion until the user
  resolves it.

Every escalation is also appended to `ESCALATIONS.md` with: cited ngspice
file + lines, the digiTS file, the specific architecture change required, and
every file it touches.

## 6a. Reviewing the applier's escalations

When the applier sets an item to `ESCALATED`, you review the escalation report
**before it reaches the user** — you are the abuse filter. Check it against
the three valid triggers in `TASK.md` §8. If it is bogus — in-scope work, a
within-group architecture change, vague, or "doesn't fit our architecture" —
clear the `ESCALATED` state in the item's `progress.json` entry (back to
`PENDING`) and append a `verifierNote` stating exactly why it is in scope and
what the applier must do. Only escalations that survive this check reach the
user. This keeps escalation from becoming the escape hatch that
`architectural-alignment.md` once was.

## 7. State transitions you may make

All transitions below are recorded by editing `spec/v41-port/progress.json`
(then running `build-ledger.mjs`), never by editing `ledger.json`.

| From | To | Condition |
|---|---|---|
| `PENDING` (ready-for-verify) | `APPLIED` | Tier 1 + Tier 2 pass |
| `PENDING` (ready-for-verify) | stays `PENDING` + `verifierNotes` | named `MISMATCH` |
| `PENDING` | `ESCALATED` | §6 |
| `ESCALATED` (bogus, §6a) | `PENDING` + `verifierNotes` | escalation review |
| `STALE` (was APPLIED, basis drifted) | `APPLIED` | re-verify Tier 1+2 vs current v41 still passes → re-record with the item's fresh `hunkHash` |
| `STALE` | stays `PENDING` + `verifierNotes` | re-verify shows the drift broke the match → applier re-ports |

**`STALE` is re-verified, never re-ported.** `build-ledger.mjs` sets `STALE` when
an item's recorded `hunkHash` no longer matches (its diff hunk or recon spec
drifted after it was recorded `APPLIED`). Re-run Tier 1+2 against current v41; if
the code still matches, record `APPLIED` with the item's **current** `hunkHash` —
a cheap refresh, not a fresh port. Only if the drift genuinely broke the match do
you leave a `MISMATCH` note for the applier. Never treat a `STALE` item as
never-done (that is the hole that re-ran vsrc 4×).

You never set `state = "NO-COUNTERPART"` — that is Phase 0 planning, frozen.
You never carry "tests pass" into a verdict.

## 8. Run completion vs job completion

A ralph **run** ends when `ledger.json` has zero `PENDING` items. The **job**
is done only when, in addition, **zero items are `ESCALATED`** — every item is
`APPLIED` or (Phase-0-frozen) `NO-COUNTERPART`. `ESCALATED` is a *blocking*
state, not a terminal one: a run that ends with escalations open is not the
finished job.

At the end of a run produce a summary: counts per state, the `ESCALATIONS.md`
list for the user, and the set of `functionGroup`s that reached `APPLIED`. If
any item is `ESCALATED`, state plainly that the job is **not** complete and
list what the user must decide. Test triage against the v41 harness is a later
phase and is out of scope for this contract.
