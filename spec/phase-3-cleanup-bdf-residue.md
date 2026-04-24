# Phase 3 Cleanup — BDF-1 / BDF-2 residue purge

**Status**: spec (not yet implemented)
**Owner**: orchestrator
**Blocking issue**: Phase 3 Wave 3.3 (`batch-p3-w3.3`) closed as "IntegrationMethod ngspice alignment — complete", but a post-phase audit finds **175 occurrences of `bdf1` / `bdf2` / `BDF-1` / `BDF-2` across 27 files**. The Phase 0 banned-literal rules added in Task 3.3.6 pass because their regexes (`/(["'])bdf1\1/`, `/(["'])bdf2\1/`) match **only standalone quoted string literals** — they miss every hyphenated prose form, every embedded identifier, every describe-block title, and every doc-comment.

This spec enumerates the residue, groups it into self-contained remediation tasks, and strengthens the Phase 0 audit so re-introduction is impossible.

---

## 1. Why this residue exists

Phase 3 Wave 3.3 scoped its cleanup to **executable references**:

> "Delete every `method === "bdf1"` / `"bdf2"` / `"trapezoidal"` branch."
> "literal remap: `'bdf1'` → `'trapezoidal'`, `'bdf2'` → `'gear'`"

The Task 3.3.6 regex `/(["'])bdf1\1/` matches `"bdf1"` / `'bdf1'` only. It does **not** match:

| Form | Example | In scope for Wave 3.3? |
|------|---------|------------------------|
| Quoted literal `"bdf1"` | `method: "bdf1"` | Yes — caught, purged |
| Substring of quoted identifier | `describe("updateCompanion_bdf1", …)` | **No** — audit passes |
| Prose hyphenated form | `// BDF-1 coefficients` | **No** — audit passes |
| Variable / constant name | `const rBdf2 = …`, `NGSPICE_REF_BDF2` | **No** — audit passes |
| Doc-comment algorithm reference | `* Uses companion model … BDF-1, trapezoidal, or BDF-2.` | **No** — audit passes |
| xmu docstring shorthand | `(0=BDF1, 0.5=trapezoidal)` | **No** — audit passes |

Consequence: the banned name survives in every human-readable surface — tests, comments, identifiers — and will re-surface every time a reviewer greps for "BDF" to understand the code.

Per `CLAUDE.md` **"ngspice Parity Vocabulary — Banned Closing Verdicts"** and the project's **"No Pragmatic Patches"** rule, the presence of `bdf1`/`bdf2` anywhere in `src/` is a vocabulary violation, not a cosmetic concern.

---

## 2. Residue inventory

Total: **27 files, 175 hits**. Expressed by type and directory.

### 2.1 Production source code (non-test `.ts` under `src/`)

| File | Lines | Nature |
|------|-------|--------|
| `src/core/analog-engine-interface.ts` | 124 | xmu docstring `(0=BDF1, 0.5=trapezoidal)` |
| `src/solver/analog/integration.ts` | 15, 17, 185 | `HistoryStore` class doc: "BDF-2 reactive element state"; `computeNIcomCof` comment: "BDF-2 only" |
| `src/solver/analog/ckt-terr.ts` | 7, 42, 43, 326 | Module doc "BDF-1 / trapezoidal / BDF-2 integrator"; GEAR_LTE_FACTORS table "(order 1, BDF-1)" / "(order 2, BDF-2)"; fallback-path comment "// GEAR / BDF-1 / BDF-2: factor-based formula" |
| `src/solver/analog/convergence-log.ts` | 65 | `exitMethod` doc: "may differ after NR-failure BDF-1 fallback" |
| `src/solver/analog/timestep.ts` | 195 | `reset()` comment: "first step runs BDF-1 semantics" |
| `src/solver/analog/analog-engine.ts` | 525, 673 | `// trial promotion from BDF-1 to trapezoidal`; `integrationOrder` doc: "1 = BDF-1 startup" |
| `src/components/passives/capacitor.ts` | 7 | Module doc: "BDF-1, trapezoidal, or BDF-2" |
| `src/components/passives/inductor.ts` | 7 | Module doc: "BDF-1, trapezoidal, or BDF-2" |
| `src/components/active/real-opamp.ts` | 327, 397, 537, 550 | Module doc "first-order BDF-1 update"; `geq_int` comment "BDF-1 companion model"; `load()` comment "BDF-1 history current"; `accept()` comment "BDF-1 history term" |

**9 files, 17 hits.**

### 2.2 Test source code (`__tests__` / `.test.ts`)

| File | Lines | Nature |
|------|-------|--------|
| `src/solver/analog/__tests__/harness/types.ts` | 190, 875 | `IterationSideData` doc `(1 = BDF-1, 2 = trap/BDF-2)` × 2 |
| `src/solver/analog/__tests__/harness/capture.ts` | 382, 476 | `endStep.params.order` doc `(1 = BDF-1, 2 = trap/BDF-2)` × 2 |
| `src/solver/analog/__tests__/integration.test.ts` | 6, 236, 280, 281 | Module doc "BDF-1, trapezoidal, BDF-2, GEAR"; test title `"trapezoidal order 1 (was BDF-1)"`; test title `"GEAR order 2 equal steps matches BDF-2"`; test body comment |
| `src/solver/analog/__tests__/compute-refs.test.ts` | 23, 25, 40, 42 | Local `const rBdf24`, `const rBdf29`; log labels `"T-04 gear:"` derived from rBdf name (already partly renamed — residue is the identifier, not the literal) |
| `src/solver/analog/__tests__/ckt-terr.test.ts` | 31, 59, 110, 134, 139, 142, 263, 284, 289, 292 | `NGSPICE_REF:` citations `order=1 GEAR (BDF-1) path` / `order=2 GEAR (BDF-2) path`; `const rBdf2 = …`; `NGSPICE_REF_BDF2:` comment label; `const NGSPICE_REF_BDF2 = …` × 2; `expect(rBdf2).toBe(NGSPICE_REF_BDF2)` × 2 |
| `src/solver/analog/__tests__/analog-engine.test.ts` | 880, 908, 921, 935, 942 | Transient test comments: "BDF-2 switching", "BDF-1 coefficients" × 4 |
| `src/components/passives/__tests__/capacitor.test.ts` | 174, 175, 183, 192, 193, 201, 407, 585, 587, 589, 609, 611, 613, 624, 643, 682 | `describe("updateCompanion_bdf1", …)`; `describe("updateCompanion_bdf2", …)`; comment `(BDF1: ccap = …)`; test-fixture comments "BDF-1 / trapezoidal order=1" × 2; ngspice ref comments "BDF-1 case" × 3; arithmetic comments "BDF-1 coefficients" × 2; `(BDF-1)` parentheticals × 4 |
| `src/components/passives/__tests__/inductor.test.ts` | 215, 216, 224, 470, 473, 475, 505 | Same pattern: describe block + comments |
| `src/components/passives/__tests__/polarized-cap.test.ts` | 288, 317, 384, 528, 555 | Transient-run comments "using BDF-1 (backward Euler)", "BDF-1 coefficients" |
| `src/components/passives/__tests__/transmission-line.test.ts` | 255, 282 | Comments "BDF-1 (geq = L/dt)", "BDF-1 geq = L/dt" |
| `src/components/passives/__tests__/tapped-transformer.test.ts` | 507, 540 | Comments "BDF-1 / trapezoidal (order=1)", "BDF-1 coefficients" |
| `src/components/active/__tests__/real-opamp.test.ts` | 155, 170 | Transient-step comments "build a transient ctx with BDF-1 coefficients" |

**12 files, ~56 hits.**

### 2.3 Docs / specs / plans (out of scope for code cleanup; retained as historical record)

| File | Disposition |
|------|-------------|
| `docs/plans/ngspice-alignment-d1-d4.md` | Historical plan doc — leave untouched |
| `spec/phase-0-audit-report.md` | Documents the banned-literal rules — leave untouched |
| `spec/plan.md`, `spec/progress.md`, `spec/phase-3-f2-nr-reorder-xfact.md` | Record the Wave 3.3 decision and what it purged — leave untouched |
| `src/solver/analog/__tests__/phase-0-identifier-audit.test.ts` | Contains the banned regexes **by necessity**; self-excluded via `THIS_FILE` — **do not edit via this spec**; Task 3.X.4 below will add new rules that also self-exclude |

---

## 3. Renaming convention (single source of truth)

All replacements follow one table. No case-by-case judgment calls.

| Old form | New form | Rationale |
|----------|----------|-----------|
| `"bdf1"` (quoted literal) | `"trapezoidal"` | Already enforced by Task 3.3.6; retained here for completeness |
| `"bdf2"` (quoted literal) | `"gear"` | Same |
| `BDF-1` (prose, capitals + hyphen) | `order-1 trap` when describing the coefficients ag[0]=1/dt, ag[1]=-1/dt as produced by our integrator; `backward Euler` when describing the underlying numerical method as a citation to ngspice-external literature | ngspice order 1 under `"trapezoidal"` produces backward-Euler coefficients (`niinteg.c:28-34`, `nicomcof.c:40-41`); our engine exposes this as "order 1 trap", not as a separate method |
| `BDF1` (prose, no hyphen — used in xmu docstring) | `backward Euler` | xmu=0 is literally the backward-Euler limit of the trapezoidal family; ngspice-conventional phrasing |
| `BDF-2` (prose, capitals + hyphen) | `gear order 2` when referring to our engine; `GEAR2` / `gear2` when the ngspice side is `"gear2"` | What digiTS once called BDF-2 is mathematically GEAR at order 2 (`nicomcof.c:52-127` Vandermonde collocation) |
| `updateCompanion_bdf1` (describe-block title) | `updateCompanion_order1_trap` | Reflects real dispatch: order 1 under trapezoidal method |
| `updateCompanion_bdf2` (describe-block title) | `updateCompanion_order2_gear` | Same, gear path |
| `rBdf2`, `rBdf24`, `rBdf29` (local constants) | `rGear2`, `rGear24`, `rGear29` | Constants capture return values of `cktTerr(…, "gear", …)` / `cktTerrVoltage(…, "gear", …)` |
| `NGSPICE_REF_BDF2` (comment label + constant) | `NGSPICE_REF_GEAR2` | Citation label for GEAR order 2 reference values |
| `"T-04 gear:"`, `"T-09 gear:"` log-label strings | no change needed (already renamed) | — |
| `(was BDF-1)` / `(was BDF-2)` parentheticals | delete outright | Vocabulary ban forbids the historical-name pattern `(was X)` — the rename is the record |
| ngspice-source citations of the form `niinteg.c BDF-1 case:` | `niinteg.c order-1 (backward-Euler) case:` | Preserves the ngspice file cite; replaces the banned name |

One exception: **`src/solver/analog/__tests__/phase-0-identifier-audit.test.ts`** is the audit itself and self-excludes. It is **not touched** by any task in this spec.

---

## 4. Task breakdown

Five tasks, ordered by blast radius. Each task is self-contained and can be assigned in parallel to implementer agents under the standard verifier gate (see §5).

### Task C-3.4.1 — Purge residue from production doc-comments (`src/` non-test)

- **Scope (9 files)**: `src/core/analog-engine-interface.ts`, `src/solver/analog/integration.ts`, `src/solver/analog/ckt-terr.ts`, `src/solver/analog/convergence-log.ts`, `src/solver/analog/timestep.ts`, `src/solver/analog/analog-engine.ts`, `src/components/passives/capacitor.ts`, `src/components/passives/inductor.ts`, `src/components/active/real-opamp.ts`.
- **Edits** (apply §3 table verbatim, no paraphrase):

  1. `src/core/analog-engine-interface.ts:124` — `(0=BDF1, 0.5=trapezoidal)` → `(0=backward Euler, 0.5=trapezoidal)`.
  2. `src/solver/analog/integration.ts:15, 17` — rewrite the `HistoryStore` class doc to describe a "two-timepoint rotating history store for reactive element state", deleting both `BDF-2` mentions. Line 185 — change `ag[2] = coefficient on Q_{n-2} (BDF-2 only)` to `ag[2] = coefficient on Q_{n-2} (order ≥ 2 only)`.
  3. `src/solver/analog/ckt-terr.ts:7` — rewrite "supported by our BDF-1 / trapezoidal / BDF-2 integrator" to "supported by our trapezoidal and gear integrators". Lines 42–43 — table annotations: `(order 1, BDF-1)` → `(order 1, trap / gear)`; `(order 2, BDF-2)` → `(order 2, gear)`. Line 326 — `// GEAR / BDF-1 / BDF-2: factor-based formula` → `// GEAR: factor-based formula (orders 1..6)`.
  4. `src/solver/analog/convergence-log.ts:65` — `(may differ after NR-failure BDF-1 fallback)` → `(may differ after NR-failure order-1 fallback)`.
  5. `src/solver/analog/timestep.ts:195` — `the first step runs BDF-1 semantics` → `the first step runs order-1 backward-Euler semantics`.
  6. `src/solver/analog/analog-engine.ts:525` — `trial promotion from BDF-1 to trapezoidal` → `trial promotion from order 1 to order 2 (trapezoidal free-running)`. Line 673 — `(1 = BDF-1 startup, 2 = order-2 free-running)` → `(1 = order-1 startup, 2 = order-2 free-running)`.
  7. `src/components/passives/capacitor.ts:7` and `src/components/passives/inductor.ts:7` — `BDF-1, trapezoidal, or BDF-2` → `trapezoidal or gear (orders 1..2)`.
  8. `src/components/active/real-opamp.ts:327, 397, 537, 550` — every `BDF-1` substring in the op-amp companion-model commentary → `backward-Euler` (the op-amp internally rolls a hand-built backward-Euler integrator; the mathematical name is correct, the banned name is not).
- **Acceptance**:
  - `grep -E '\bBDF[-_ ]?[12]\b|\bbdf[12]\b' src/core/ src/solver/ src/components/ --include='*.ts' -r` limited to non-`__tests__` paths returns **zero hits**.
  - No behavioural change; this task edits comments/doc-strings only.
- **Size**: S (comment-only edits, 17 hits across 9 files).

### Task C-3.4.2 — Purge residue from test source under `src/solver/analog/__tests__/`

- **Scope (6 files)**: `harness/types.ts`, `harness/capture.ts`, `integration.test.ts`, `compute-refs.test.ts`, `ckt-terr.test.ts`, `analog-engine.test.ts`.
- **Edits** (apply §3 table):

  1. `harness/types.ts:190, 875` and `harness/capture.ts:382, 476` — `(1 = BDF-1, 2 = trap/BDF-2)` → `(1 = order-1 trap/gear, 2 = order-2 trap/gear)`. The harness comments currently assert a false equivalence (claims BDF-2 = trapezoidal order 2); the correct statement names the order, not the method.
  2. `integration.test.ts`:
     - Line 6 — module doc list `BDF-1, trapezoidal, BDF-2, GEAR` → `trapezoidal (orders 1..2), gear (orders 1..6)`.
     - Line 236 test title `"trapezoidal order 1 (was BDF-1): ag[0]=1/dt, ag[1]=-1/dt"` → `"trapezoidal order 1: ag[0]=1/dt, ag[1]=-1/dt"` (delete `(was BDF-1)` parenthetical).
     - Line 280 test title `"GEAR order 2 equal steps matches BDF-2: ag[0]=3/(2h), ag[1]=-2/h, ag[2]=1/(2h)"` → `"GEAR order 2 equal steps: ag[0]=3/(2h), ag[1]=-2/h, ag[2]=1/(2h)"` (delete `matches BDF-2` reference).
     - Line 281 test-body comment `GEAR method with order=2 and equal steps should produce same coefficients as BDF-2.` → delete the sentence; the ag[] assertions already encode the numerical claim.
  3. `compute-refs.test.ts:23, 40` — rename `rBdf24` → `rGear24`, `rBdf29` → `rGear29`. Lines 25, 42 — log labels already say `"T-04 gear:"` / `"T-09 gear:"`; no change needed.
  4. `ckt-terr.test.ts`:
     - Lines 31, 59 — `NGSPICE_REF:` citation parentheticals `(BDF-1) path` / `(BDF-2) path` → delete parentheticals (`order=1 GEAR path`, `order=2 GEAR path`).
     - Line 110 `const rBdf2 = …` → `const rGear2 = …`; downstream expect line updated to `expect(rGear2)…`.
     - Line 134 `// NGSPICE_REF_BDF2:` → `// NGSPICE_REF_GEAR2:`.
     - Line 139 `const NGSPICE_REF_BDF2 = …` → `const NGSPICE_REF_GEAR2 = …`.
     - Line 142 `expect(rBdf2).toBe(NGSPICE_REF_BDF2)` → `expect(rGear2).toBe(NGSPICE_REF_GEAR2)`.
     - Line 263 `const rBdf2 = …` → `const rGear2 = …`.
     - Line 284 `// NGSPICE_REF_BDF2:` → `// NGSPICE_REF_GEAR2:`.
     - Line 289 `const NGSPICE_REF_BDF2 = …` → `const NGSPICE_REF_GEAR2 = …`.
     - Line 292 `expect(rBdf2).toBe(NGSPICE_REF_BDF2)` → `expect(rGear2).toBe(NGSPICE_REF_GEAR2)`.
  5. `analog-engine.test.ts:880, 908, 921, 935, 942` — transient-test comments:
     - Line 880 `would have triggered BDF-2 switching` → `would have triggered order-2 (gear) switching`.
     - Lines 908, 921, 935, 942 — `BDF-1 coefficients` / `BDF-1 (order 1)` / `for BDF-1 (order 1)` → `order-1 trap coefficients` / `order 1` / `for order 1`.
- **Acceptance**:
  - All tests in the six files pass. **Numerical assertions unchanged — this task is rename-only.**
  - `grep -E '\bBDF[-_ ]?[12]\b|\bbdf[12]\b' src/solver/analog/__tests__/ --include='*.ts' -r` returns **zero hits** (the audit test file itself is scoped out: its occurrences are inside regex literals and comment-adjacent descriptions that the audit self-excludes via THIS_FILE).
- **Size**: M (~18 identifier renames + ~30 comment edits across 6 files).

### Task C-3.4.3 — Purge residue from test source under `src/components/`

- **Scope (6 files)**: `passives/__tests__/capacitor.test.ts`, `passives/__tests__/inductor.test.ts`, `passives/__tests__/polarized-cap.test.ts`, `passives/__tests__/transmission-line.test.ts`, `passives/__tests__/tapped-transformer.test.ts`, `active/__tests__/real-opamp.test.ts`.
- **Edits** (apply §3 table):
  1. `capacitor.test.ts:174` — `describe("updateCompanion_bdf1", …)` → `describe("updateCompanion_order1_trap", …)`. Line 192 — `describe("updateCompanion_bdf2", …)` → `describe("updateCompanion_order2_gear", …)`. All interior `BDF-1`/`BDF-2`/`BDF1` in the `it(…)` titles and comments per §3 table (`BDF-1 method` → `order-1 trap method`; `BDF-2 method` → `order-2 gear method`; `(BDF1: …)` parenthetical → `(order-1: …)`; header banners `BDF-1 / trapezoidal order=1` → `order-1 trap`; ngspice-citation comments `niinteg.c BDF-1 case` → `niinteg.c order-1 (backward-Euler) case`).
  2. `inductor.test.ts:215` — same describe-block rename pattern. Interior comments per §3 table.
  3. `polarized-cap.test.ts:288, 317, 384, 528, 555` — every `BDF-1` → `order-1 trap` (or `backward Euler` when the comment already uses that parenthetical). Line 384 `BDF-1 has first-order error` → `order-1 trap has first-order error`.
  4. `transmission-line.test.ts:255, 282` — `BDF-1 (geq = L/dt)` → `order-1 trap (geq = L/dt)`.
  5. `tapped-transformer.test.ts:507, 540` — `BDF-1 / trapezoidal (order=1)` → `order-1 trap`.
  6. `real-opamp.test.ts:155, 170` — `with BDF-1 coefficients` → `with order-1 trap coefficients`.
- **Acceptance**:
  - All tests in the six files pass. **No numerical / assertion changes — rename-only.**
  - `grep -E '\bBDF[-_ ]?[12]\b|\bbdf[12]\b' src/components/ --include='*.ts' -r` returns **zero hits**.
- **Size**: M (2 describe-block renames + ~45 comment edits across 6 files).

### Task C-3.4.4 — Strengthen Phase 0 audit to block residue re-introduction

- **Scope**: `src/solver/analog/__tests__/phase-0-identifier-audit.test.ts`, `spec/phase-0-audit-report.md`.
- **Edits**:

  1. Extend `BANNED_IDENTIFIERS` with two new entries (keep the three existing Wave 3.3 entries — they guard the quoted-literal forms; these add prose + identifier coverage):

     ```ts
     {
       id: "bdf-hyphenated",
       regex: /BDF[-_ ][12]/i,
       description:
         "Phase 3 Cleanup: 'BDF-1' / 'BDF-2' (and _1 / _2 / space-1 / space-2 variants, " +
         "any case) is the banned prose name for integration methods. Order 1 under " +
         "trapezoidal or gear uses trap-1 coefficients (nicomcof.c:40-41); what was " +
         "called BDF-2 is GEAR order 2 (nicomcof.c:52-127). Use 'order-1 trap', " +
         "'backward Euler', or 'gear order 2' instead.",
     },
     {
       id: "bdf-substring",
       regex: /bdf[12]/i,
       description:
         "Phase 3 Cleanup: 'bdf1' / 'bdf2' (any case, any position — standalone " +
         "literal, suffix of an identifier, substring of a constant label, etc.) " +
         "is banned. Covers 'rBdf2', 'NGSPICE_REF_BDF2', 'updateCompanion_bdf1', " +
         "'BDF1'-run-together-in-prose, etc. Rename to 'order1_trap' / 'order2_gear' / " +
         "'gear2' / 'rGear2' / 'NGSPICE_REF_GEAR2' as appropriate. Note: this regex " +
         "deliberately has no word-boundary anchors — the older 3.3.6 rules use " +
         "`(["'])bdf1\\1` which already scopes to quoted literals; this rule must " +
         "catch the identifier-embedded cases those regexes miss.",
     },
     ```

     **Regex-correctness note.** An earlier draft used `\bbdf[12]\b`. That form misses `rBdf2`, `NGSPICE_REF_BDF2`, `updateCompanion_bdf1` (no word boundary inside a compound identifier) — exactly the cases the audit has to catch. The two regexes above, together, cover: quoted-literal (via the three existing Wave 3.3 rules), hyphenated-prose (via `bdf-hyphenated`, any case), and identifier-embedded / run-together (via `bdf-substring`, any case, unbounded).

  2. Append two rows to `spec/phase-0-audit-report.md` matching the layout of the existing `bdf1-literal` / `bdf2-literal` rows. Reasons mirror the `description` fields above.

  3. Confirm `THIS_FILE` self-exclusion still applies — both new regexes will match inside the audit file itself (in their own `description` strings); the existing `THIS_FILE` guard must continue to exempt `phase-0-identifier-audit.test.ts`.

- **Acceptance**:
  - `phase-0-identifier-audit.test.ts` passes after Tasks C-3.4.1, C-3.4.2, C-3.4.3 are merged. It MUST fail if any of those three tasks is skipped — this is the gate.
  - Re-running the audit after a synthetic re-introduction (`grep` finds, say, `// BDF-1 coefficients` reintroduced into any `src/**/*.ts`) fails the audit.
  - `spec/phase-0-audit-report.md` shows five Wave-3.3-era rows: the three existing (`bdf1-literal`, `bdf2-literal`, `integrationMethod-auto`) plus two new (`bdf-prose`, `bdf-identifier`).
- **Size**: S (two manifest entries + two report rows).
- **Ordering constraint**: This task MUST land **after** Tasks C-3.4.1 + C-3.4.2 + C-3.4.3, or the audit turns red and blocks CI. Either land all four in one merge, or land C-3.4.4 last.

### Task C-3.4.5 — Verifier pass

- **Agent**: `oh-my-claudecode:verifier` (per `CLAUDE.md` Verification Gate).
- **Inputs**: this spec + diffs from C-3.4.1…C-3.4.4.
- **Checks**:
  1. `grep -rE '\bBDF[-_ ]?[12]\b|\bbdf[12]\b' src/ --include='*.ts'` excluding `phase-0-identifier-audit.test.ts` returns **zero hits**.
  2. `phase-0-identifier-audit.test.ts` passes (enforcement confirmed).
  3. Full `npm run test:q` run: **no numerical regression vs the pre-cleanup baseline**. This task is a pure rename; any numerical change is a bug in an implementer agent's work and is blocker-severity.
  4. The five banned-literal manifest entries are present; `THIS_FILE` self-exclusion is operative.
- **Exit condition**: all four checks pass, or the verifier returns a blocker report for the orchestrator.

---

## 5. Ordering and parallelism

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  C-3.4.1     │    │  C-3.4.2     │    │  C-3.4.3     │
│  prod doc-   │    │  solver test │    │  component   │
│  comments    │    │  renames     │    │  test renames│
│  (9 files)   │    │  (6 files)   │    │  (6 files)   │
└──────┬───────┘    └──────┬───────┘    └──────┬───────┘
       │ parallel          │ parallel          │ parallel
       └───────────────────┼───────────────────┘
                           ▼
                   ┌──────────────┐
                   │  C-3.4.4     │
                   │  audit       │
                   │  strengthen  │
                   └──────┬───────┘
                          ▼
                   ┌──────────────┐
                   │  C-3.4.5     │
                   │  verifier    │
                   └──────────────┘
```

C-3.4.1, C-3.4.2, C-3.4.3 are fully independent (disjoint file sets). Run in parallel. C-3.4.4 depends on all three (§4, Ordering constraint). C-3.4.5 is the gate.

---

## 6. Non-goals

- **Does not touch** `docs/plans/ngspice-alignment-d1-d4.md`, `spec/plan.md`, `spec/progress.md`, `spec/phase-0-audit-report.md`, `spec/phase-3-f2-nr-reorder-xfact.md` — those are the historical record of the Wave 3.3 decision and retain the old names by design.
- **Does not touch** `src/solver/analog/__tests__/phase-0-identifier-audit.test.ts` outside of Task C-3.4.4's two-entry append — the file self-excludes and must continue to.
- **Does not change engine behaviour or numerical output.** Every edit is a rename of comment, doc-string, test title, local identifier, or describe-block label. If any task produces a numerical diff, that is a regression and per the project's `Regression Policy` the implementer must stop and escalate, not revert.
- **Does not** add a new integration method, remove one, or adjust `IntegrationMethod` type.

---

## 7. Why this is a real cleanup, not cosmetic

Per `CLAUDE.md`:

> **ngspice Parity Vocabulary — Banned Closing Verdicts**
> … used as closing verdicts, raised the tolerance floor across the project and sheltered real numerical bugs. Banning them at the vocabulary level prevents the drift.

The Wave 3.3 audit banned the **string literal** but left the **name** alive in 175 places across 27 files. A future agent grepping `BDF-1` will find the old vocabulary everywhere and be invited to reason about the engine in terms of a method that doesn't exist. That is precisely the drift the vocabulary rule is supposed to prevent. The cleanup in this spec completes the purge at the vocabulary level, not just at the dispatch level.
