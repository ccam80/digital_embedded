# Citation Verification Batches

## Purpose

Phase 8 produced a 1,284-row inventory of every ngspice citation in `src/**/*.ts` (`spec/ngspice-citation-audit.json`). After the post-Phase-8 review reset (see `spec/reviews/phase-8.md` and `spec/progress.md` "Phase 8 review reset — 2026-04-25"), every row is `status: unverified` except 11 stale and 2 missing rows that survived the reset.

This spec enumerates the verification work needed to flip those rows to `verified` (or `stale` with proposed correction, or `missing` if the cited file does not exist in `ref/ngspice/`). It is the follow-up to Phase 8 and the broader analogue of Phase 9.1.2 (which is a 10-citation random sample with expand-on-rot scoping). When the batches in this spec are complete, every citation in `src/**/*.ts` has been actively inspected against the vendored ngspice source, not just the priority files Phase 8 covered or the random sample Phase 9.1.2 lands.

This spec does **not** schedule the batches. Each batch is a discrete, parallel-safe task; the user decides which to run, in which order, and at which scale. The orchestrator may run all 50 batches in parallel, run them serially, or split a batch across multiple agents — the per-batch contract below applies regardless.

## Governing rules (apply to every batch)

- **One ngspice file per agent.** An agent owns exactly one ngspice document for the duration of its task. It reads that document **in full**, including header guards, `#define` / `#undef` blocks, mode toggles (`MODEINITJCT`, `MODEUIC`, `INITF` flags, etc.), and any sibling functions in the same compilation unit that the cited code interacts with. It does not skim; it reads the whole file, then reasons.
- **High bar for equivalence.** "Slightly different but architecturally equivalent" is not equivalence. If digiTS reorders, fuses, splits, or adds error-handling that ngspice does not perform — and the agent cannot show that the divergence is invisible to the cited variable / branch / state — the row is **NOT** verified. Surface the divergence as a failure with a one-line reason. The user decides whether to amend the spec, file an architectural-alignment entry, or fix the source.
- **Banned closing verdicts.** Do not close any row by writing *mapping*, *mapping table*, *tolerance*, *within tolerance*, *close enough*, *equivalent under*, *pre-existing*, *intentional divergence*, *citation divergence*, *partial*, or *documentation hygiene* in `notes`. These words are forbidden by `CLAUDE.md` "ngspice Parity Vocabulary — Banned Closing Verdicts". A failure is a failure; escalate it.
- **No source edits.** This is documentation work. The verifier may NOT edit `src/**/*.ts`, `ref/ngspice/`, or any non-spec file. The only files it may modify are `spec/ngspice-citation-audit.json` (status flips) and the per-batch report it writes.
- **No status: verified by agent without claimKeyword.** A `verified` row must carry a non-empty `claimKeyword` that **literally appears** in the cited line range (or anywhere in the file, for file-only cites). The tightened `InventoryStructure::verifiedRowsResolve` test enforces this.
- **Status semantics (re-stated for clarity):**

  | Status | Means |
  |---|---|
  | `verified` | Agent read the ngspice file end-to-end, opened the cited range, confirmed the digiTS comment's claim is faithful to the cited code under all relevant modes. `claimKeyword` is recorded and is literally present in the cited range. |
  | `stale` | Agent read the file and found the citation does not resolve to the claimed content. `notes` carries a proposed corrected citation in `<file>:<range>` form. |
  | `missing` | The named ngspice file does not exist under `ref/ngspice/`, or the cite has no resolvable line range. `ngspicePath` is empty. |
  | `unverified` | Default. Agent has not yet inspected this row. |

## Equivalence bar (verbatim from user direction)

> "Each agent owns a single ngspice document that it reads in full and understands well (including mode toggles and #defs/#undefs), then it reads our sources that cite it and sees if the usage is actually equivalent. They should have a high bar for equivalence — if it looks like they're slightly different 'but it might just be an architectural difference', they should surface this as a failure with a brief reason."

Operationalised as a per-row decision rule:

1. Agent reads the ngspice file in full. Records (in scratch, not in JSON) any `#define` / `#undef` / `#ifdef` / mode-flag pivots that change the cited code's behaviour.
2. Agent opens each digiTS row that cites this ngspice file. Reads the digiTS comment, the surrounding code (±20 lines), and any control-flow / mode that gates entry to the cited block.
3. Agent asks: *"Under every combination of the modes / defines that ngspice exercises at the cited line range, does the digiTS code do **the same thing** as the ngspice code?"*
4. If yes → `verified`. Record `claimKeyword` (a function name, macro, or distinctive symbol that literally appears in the cited range).
5. If the citation resolves to different content than the digiTS comment claims → `stale`. Write the proposed correction in `notes`.
6. If the digiTS code does something the ngspice code does not, or omits something ngspice does, **even if the agent suspects the divergence is "architectural"** → leave `unverified` and record the reason in the per-batch report's "Surfaced divergences" section. The user reviews and decides.
7. If the named ngspice file does not exist under `ref/ngspice/` → `missing`.

## Pre-batch cleanup (run before any verification batch)

Four rows have broken `ngspicePath` values that must be resolved before any batch can verify them. These are spec-author errors, not ngspice rot; they should be fixed in a single small task before parallel batches launch.

| ID | sourceFile:line | Cite | Current ngspicePath | Action |
|---|---|---|---|---|
| C-0468 | `src/components/semiconductors/mosfet.ts:72` | `defines.h:35` | `ref/ngspice/src/include/defines.h` | Locate the actual path of the cited `defines.h` (likely `ref/ngspice/src/include/ngspice/devdefs.h` or similar) or mark `missing` if no match. |
| C-0773 | `src/components/semiconductors/__tests__/bjt.test.ts:2262` | `dctran.c:317` | `ref/ngspice/src/analysis/dctran.c` | Correct path to `ref/ngspice/src/spicelib/analysis/dctran.c`. |
| C-0966 | `src/solver/analog/complex-sparse-solver.ts:24` | `spConfig.h:331` | (empty) | Resolve to `ref/ngspice/src/maths/sparse/spconfig.h` if that file exists; else mark `missing`. |
| C-0967 | `src/solver/analog/complex-sparse-solver.ts:29` | `spConfig.h:331` | (empty) | Same as C-0966. |

## Per-batch task template

Use this template verbatim when constructing each batch's agent prompt. Substitute `{{NGSPICE_FILE}}`, `{{NGSPICE_LINES}}`, `{{ROW_IDS}}`, `{{REPORT_PATH}}`.

```
# Citation Verification Batch — {{NGSPICE_FILE}}

You own ngspice file `{{NGSPICE_FILE}}` ({{NGSPICE_LINES}} lines) for this task. Your job is to verify every digiTS citation that resolves to this file, exactly as defined in `spec/citation-verification-batches.md`. Read that spec's "Governing rules" and "Equivalence bar" sections before doing anything else.

## Step 1 — Read the ngspice file in full

Read `{{NGSPICE_FILE}}` end to end. While reading, record (in scratch — do not write to disk yet) every:
- function definition and what it returns
- `#define` / `#undef` / `#ifdef` / `#if` block that changes behaviour
- mode-flag branch (`MODEINITJCT`, `MODEINITFLOAT`, `MODEUIC`, `MODEDC`, `MODETRAN`, `MODEAC`, `INITF` enums, `CKTmode` reads, `bypass` / `nobypass` toggles, etc.)
- file-level static globals
- order of operations in any function ≥30 lines

Do not skim. If the file is too large for a single Read call, do multiple Read calls covering the whole file in order. You must understand the whole file before checking citations.

## Step 2 — Verify each citation

The inventory rows for this batch are:

{{ROW_IDS}} (load these from `spec/ngspice-citation-audit.json` by `id`)

For each row:

1. Read the digiTS source at `row.sourceFile`, ±30 lines around `row.sourceLine`. Understand the digiTS function, the modes it operates under, and what `row.claim` is asserting.
2. Cross-check the cited ngspice line range against your full-file understanding from Step 1. Confirm the digiTS code does **the same thing** under all relevant modes and defines.
3. Apply the equivalence bar from `spec/citation-verification-batches.md` — high bar, no "architectural" hand-waving.
4. Decide the row's new status:
   - `verified` — record `claimKeyword` (a literal token from the cited range), clear `notes`.
   - `stale` — leave `claimKeyword` as-is, write a proposed correction in `notes` as `"<file>:<range>"`.
   - `unverified` — leave the row alone; record the divergence in your per-batch report's "Surfaced divergences" section.
   - `missing` — empty `ngspicePath`, write reason in `notes`.

## Step 3 — Emit the inventory patch (do NOT edit the JSON directly)

Do NOT edit `spec/ngspice-citation-audit.json` in place. Multiple batches run in parallel; direct edits collide. Instead, emit a JSON patch list as part of your per-batch report. The coordinator will apply patches in a single serialised pass after the wave completes (see "Inventory and notepad edit protocol" in the spec).

The patch list is an array of objects, one per row in your batch:

```json
[
  { "id": "C-0123", "status": "verified", "claimKeyword": "BJTconvTest", "notes": "" },
  { "id": "C-0124", "status": "stale", "claimKeyword": "", "notes": "Proposed: bjtload.c:412-418" },
  { "id": "C-0125", "status": "missing", "claimKeyword": "", "notes": "ngspice file does not exist in vendored ref tree", "ngspicePath": "" }
]
```

Include `ngspicePath` only when you flip a row to `missing` and need to clear or correct it. Do not include any field other than `id`, `status`, `claimKeyword`, `notes`, and (optionally) `ngspicePath`.

## Step 4 — Write the per-batch report

Write your report to `{{REPORT_PATH}}` with this structure:

```
# Citation Verification Report — {{NGSPICE_FILE}}

## Summary
- Rows in batch: <count>
- Verified: <count>
- Stale: <count>
- Missing: <count>
- Surfaced as divergence (left unverified): <count>

## File understanding
This section is the source of the entry that will be merged into `ref/ngspice/control-flow-notes.md` (see "Ngspice control-flow notepad" in `spec/citation-verification-batches.md`). Write it in the schema below — the coordinator copies it directly:

### {{NGSPICE_FILE_BASENAME}} ({{NGSPICE_LINES}} lines)
- **Purpose**: one paragraph on what this file does in ngspice's overall architecture.
- **Modes / defines that gate behaviour**: bullet list of `MODEINIT*`, `MODEUIC`, `INITF` enums, `CKTmode` reads, `#ifdef` blocks, and `bypass` toggles that change which branch executes. For each, note the condition and the effect.
- **Functions and roles**: bullet list of every function defined in the file with a one-line role description.
- **Control-flow / branches** (the load-bearing part): for each non-trivial conditional or loop, record `condition → effect`. E.g., `if (CKTmode & MODEINITJCT) → set Vbe = vt0, force first-iter operating point`. Be thorough on the major functions; skim the trivial helpers.
- **State maintained**: file-level static globals, hidden state in `CKTcircuit *ckt` that this file writes, anything stashed in `ckt->CKTstate0[NN]`.
- **Subtleties / gotchas**: one-line items the next reader needs to know — order-of-operations, side effects, instrumentation (e.g., `niiter.c` has `ni_instrument_cb` that shifts line numbers vs upstream), divergences from upstream ngspice if any.

For combined batches that own multiple ngspice files, repeat the section per file.

## Per-row verdicts
| id | sourceFile:line | cite | new status | claimKeyword | one-line reason |

## Surfaced divergences
For every row left `unverified` because the digiTS code is not equivalent to the ngspice code, write a brief subsection:
### {row id}
- digiTS: {what it does, file:line}
- ngspice: {what {{NGSPICE_FILE}} does at the cited range}
- Divergence: {one or two lines describing the difference}
- Why this is a real divergence, not architectural noise: {one or two lines}
```

## Step 5 — Run the citation-audit tests

Run `npx vitest run --testTimeout=120000 src/solver/analog/__tests__/citation-audit.test.ts` and report pass/fail count. The expected post-batch state for your batch is: every row you flipped to `verified` passes `InventoryStructure::verifiedRowsResolve` (claimKeyword literally appears in the cited range / file).

## Constraints

- Do NOT edit any file under `src/`, `e2e/`, `ref/ngspice/src/`, or anything outside `spec/` and `ref/ngspice/control-flow-notes.md`. The notepad file is the **only** writable target under `ref/ngspice/`; the vendored source tree itself is read-only.
- Do NOT use any banned closing verdict (mapping, tolerance, equivalent under, pre-existing, intentional divergence, citation divergence, partial, etc.).
- Do NOT mark a row `verified` unless your full-file understanding lets you defend it against an adversarial reviewer.
- If a row's citation resolves correctly **and** the digiTS code matches **and** you can record a literal claimKeyword — only then is the row verified.
```

## Ngspice control-flow notepad

Each batch agent's "File understanding" report section accumulates into a single durable artifact: `ref/ngspice/control-flow-notes.md`. This is a **shared reference bucket** describing the control flow, branch conditions, mode toggles, and effects for every ngspice file digiTS cites. It outlives the verification batches — future agents debugging a numerical issue can read this file to orient themselves on ngspice's behaviour without re-reading the source from scratch.

### Structure

`ref/ngspice/control-flow-notes.md` is one Markdown file. Each ngspice file gets one top-level section keyed by relative path:

```markdown
# ngspice control-flow notes

This file is generated by the citation verification batches (see `spec/citation-verification-batches.md`). Each section below was authored by the agent that owned that ngspice document during a verification pass. Do not hand-edit — re-run the verification batch for the affected file instead.

## ref/ngspice/src/spicelib/analysis/cktop.c (629 lines)
- **Purpose**: ...
- **Modes / defines that gate behaviour**: ...
- **Functions and roles**: ...
- **Control-flow / branches**: ...
- **State maintained**: ...
- **Subtleties / gotchas**: ...

## ref/ngspice/src/spicelib/devices/bjt/bjtload.c (847 lines)
- ...
```

Sections are ordered alphabetically by ngspice path. Sub-batches that share an ngspice file (e.g., 1A and 1B both own `bjtload.c`) emit independent "File understanding" sections in their per-batch reports; the coordinator merges them into one canonical section in the notepad, taking the **union** of insights and flagging substantive disagreements for user review.

### Concurrency

Agents do **not** write to `ref/ngspice/control-flow-notes.md` directly during a batch. They emit their section into their per-batch report (Step 4 of the per-batch task template). After a wave of batches completes, the coordinator merges each report's "File understanding" section into the notepad. This avoids file-lock contention on the shared notepad while preserving each agent's authored section verbatim.

If `ref/ngspice/control-flow-notes.md` does not exist before the first wave, the coordinator creates it with a one-line header. Subsequent waves append new sections and update existing ones in place.

### Lifecycle

The notepad is durable — it survives across phases. Future work that uncovers a behavioural change in an ngspice file (e.g., the harness reveals that a `MODEINITJCT` branch we ignored matters) updates the relevant section in the notepad as part of the fix. The "Subtleties / gotchas" subsection is where most of that drift lands.

The notepad is **not** authoritative — `ref/ngspice/src/` itself is. If the notepad and the source disagree, the source wins; the notepad gets corrected.

## Enumerated batches (refined)

The enumeration below splits the three heaviest single-file batches into two sub-batches each (per user direction: cap any one batch at ~120 rows) and combines five small `spicelib/analysis/` files into one cohesive batch (5 files share a coherent domain — analysis-control-flow primitives — and total only 13 cites in 846 ngspice lines, well within one agent's budget).

After these refinements: **46 batches total** (was 47). Heaviest batch drops from 228 rows to ~114.

`cites` = number of inventory rows. `srcs` = distinct digiTS source files. `ngLines` = total ngspice lines in the batch's owned file(s). Sub-batches sharing an ngspice file each read it in full independently — the small redundancy is accepted in exchange for two independent eyes on the document.

### Heavy splits (3 files → 6 sub-batches)

| # | cites | srcs | ngLines | ngspice file | Partition |
|---|-------|------|---------|--------------|-----------|
| 1A | ~114 | 5 | 847 | `ref/ngspice/src/spicelib/devices/bjt/bjtload.c` | `bjt.ts` rows where sourceLine ≤ T (T chosen at launch so 1A and 1B are within ±10%) **plus** all non-`bjt.ts` cites of bjtload.c (`bjt.test.ts` 53, `optocoupler.ts` 4, `timer-555.ts` 4, 2 misc) |
| 1B | ~114 | 1 | 847 | `ref/ngspice/src/spicelib/devices/bjt/bjtload.c` | `bjt.ts` rows where sourceLine > T |
| 2A | 73 | 1 | 446 | `ref/ngspice/src/spicelib/devices/dio/dioload.c` | `diode.ts` rows only |
| 2B | 65 | 9 | 446 | `ref/ngspice/src/spicelib/devices/dio/dioload.c` | All non-`diode.ts` cites of dioload.c (`zener.ts` 33, `diode.test.ts` 14, `polarized-cap.ts` 7, `optocoupler.ts` 4, `zener.test.ts` 3, 4 misc) |
| 3A | 54 | 8 | 1013 | `ref/ngspice/src/spicelib/analysis/dctran.c` | "Engine layer": `analog-engine.ts` (40), `analog-engine-interface.ts` (3), `analog-engine.test.ts` (3), `state-pool.ts` (3), `ckt-context.ts` (2), `ckt-context.test.ts` (1), `coordinator.ts` (1), `comparison-session.ts` (1) |
| 3B | 51 | 6 | 1013 | `ref/ngspice/src/spicelib/analysis/dctran.c` | "Stepping/NR/DCOP layer": `timestep.ts` (37), `timestep.test.ts` (5), `dc-operating-point.ts` (5), `newton-raphson.ts` (1), `newton-raphson.test.ts` (1), `bjt.ts` (2) |

### Combined batch (5 files → 1 batch)

| # | cites | srcs | ngLines | ngspice files | Notes |
|---|-------|------|---------|---------------|-------|
| C1 | 13 | (varies) | 846 total | `cktntask.c` (4 cites, 128 lines), `cktncdump.c` (2, 44), `ckttrunc.c` (3, 188), `traninit.c` (2, 39), `acan.c` (2, 447) | All under `ref/ngspice/src/spicelib/analysis/`. Coherent domain: analysis-control-flow scaffolding (task setup, non-convergence dump, truncation error, transient init, AC analysis). Agent reads all 5 files in full, emits 5 separate sections to the notepad. |

### Single-file batches (38)

| # | cites | srcs | ngLines | ngspice file |
|---|-------|------|---------|--------------|
| 4 | 99 | 4 | 961 | `ref/ngspice/src/spicelib/devices/mos1/mos1load.c` |
| 5 | 90 | 2 | 555 | `ref/ngspice/src/spicelib/devices/jfet/jfetload.c` |
| 6 | 72 | 5 | 128 | `ref/ngspice/src/spicelib/devices/ind/indload.c` |
| 7 | 59 | 11 | 446 | `ref/ngspice/src/include/ngspice/cktdefs.h` |
| 8 | 48 | 4 | 88 | `ref/ngspice/src/spicelib/devices/cap/capload.c` |
| 9 | 43 | 3 | 629 | `ref/ngspice/src/spicelib/analysis/cktop.c` |
| 10 | 42 | 14 | 81 | `ref/ngspice/src/maths/ni/niinteg.c` |
| 11 | 31 | 1 | 157 | `ref/ngspice/src/spicelib/devices/sw/swload.c` |
| 12 | 31 | 9 | 1096 | `ref/ngspice/src/maths/ni/niiter.c` |
| 13 | 29 | 2 | 333 | `ref/ngspice/src/spicelib/devices/mos1/mos1temp.c` |
| 14 | 29 | 2 | 2955 | `ref/ngspice/src/maths/sparse/spfactor.c` |
| 15 | 28 | 5 | 210 | `ref/ngspice/src/maths/ni/nicomcof.c` |
| 16 | 25 | 4 | 801 | `ref/ngspice/src/spicelib/devices/devsup.c` |
| 17 | 23 | 1 | 107 | `ref/ngspice/src/spicelib/devices/sw/swdefs.h` |
| 18 | 23 | 7 | 186 | `ref/ngspice/src/spicelib/analysis/cktload.c` |
| 19 | 14 | 3 | 554 | `ref/ngspice/src/maths/sparse/spsmp.c` |
| 20 | 12 | 2 | 78 | `ref/ngspice/src/spicelib/analysis/cktterr.c` |
| 21 | 10 | 2 | 118 | `ref/ngspice/src/spicelib/devices/jfet/jfettemp.c` |
| 22 | 9 | 3 | 181 | `ref/ngspice/src/spicelib/analysis/dcop.c` |
| 23 | 9 | 3 | 2181 | `ref/ngspice/src/maths/sparse/sputils.c` |
| 24 | 8 | 3 | 307 | `ref/ngspice/src/spicelib/devices/jfet/jfetdefs.h` |
| 25 | 8 | 1 | 808 | `ref/ngspice/src/maths/sparse/spdefs.h` |
| 26 | 7 | 1 | 272 | `ref/ngspice/src/spicelib/devices/dio/diotemp.c` |
| 27 | 7 | 4 | 136 | `ref/ngspice/src/spicelib/devices/cktinit.c` |
| 28 | 7 | 1 | 153 | `ref/ngspice/src/maths/ni/nipred.c` |
| 29 | 6 | 2 | 886 | `ref/ngspice/src/maths/sparse/spalloc.c` |
| 30 | 5 | 5 | 423 | `ref/ngspice/src/spicelib/devices/vsrc/vsrcload.c` |
| 31 | 4 | 2 | 1207 | `ref/ngspice/src/maths/sparse/spbuild.c` |
| 32 | 3 | 2 | 521 | `ref/ngspice/src/spicelib/devices/mos1/mos1defs.h` |
| 33 | 2 | 1 | 79 | `ref/ngspice/src/spicelib/devices/res/resload.c` |
| 34 | 2 | 2 | 269 | `ref/ngspice/src/spicelib/devices/dio/diosetup.c` |
| 35 | 2 | 2 | 90 | `ref/ngspice/src/spicelib/devices/jfet/jfet.c` |
| 36 | 2 | 2 | 403 | `ref/ngspice/src/maths/sparse/spconfig.h` |
| 37 | 2 | 2 | 45 | `ref/ngspice/src/maths/ni/nireinit.c` |
| 38 | 1 | 1 | 265 | `ref/ngspice/src/spicelib/devices/bjt/bjttemp.c` |
| 39 | 1 | 1 | 160 | `ref/ngspice/src/spicelib/devices/cap/capdefs.h` |
| 40 | 1 | 1 | 211 | `ref/ngspice/src/spicelib/devices/ind/inddefs.h` |
| 41 | 1 | 1 | 360 | `ref/ngspice/src/spicelib/devices/dio/diodefs.h` |
| 42 | 1 | 1 | 766 | `ref/ngspice/src/spicelib/devices/bjt/bjtdefs.h` |

**Note**: numbering in this section runs 4-42 to leave room for batches 1A/1B/2A/2B/3A/3B (split heavy) at the top and C1 (combined) between split and singletons. Total: 6 (split) + 1 (combined) + 39 (single, including the 38 above plus the 4 from pre-batch cleanup) = 46.

The five `spicelib/analysis/` files moved into batch C1 (`cktntask.c`, `cktncdump.c`, `ckttrunc.c`, `traninit.c`, `acan.c`) are removed from this single-file table.

### Pre-batch cleanup feeds these batches

After the cleanup table at the top of this spec runs:
- C-0468 (`defines.h`) — joins one of the existing batches if its path resolves; otherwise new singleton or `missing`.
- C-0773 (`dctran.c:317`) — joins batch 3A or 3B based on its `sourceFile` (`bjt.test.ts` → 3B's "stepping" half).
- C-0966, C-0967 (`spConfig.h:331`) — join batch 36 (`spconfig.h`).

The orchestrator runs pre-batch cleanup first, then re-counts the affected batches, then dispatches all 46.

## Batching strategy notes (advisory, not contractual)

- **Heavy batches (>50 cites)**: 1A, 1B, 2A, 2B, 3A, 3B, 4 (`mos1load.c`), 5 (`jfetload.c`), 6 (`indload.c`), 7 (`cktdefs.h`). The agent will spend most of its time on Step 2 (per-row verification). Each row is independent within the batch, so an agent can interleave reading and verdicting. Expect 30-60 minutes per heavy batch with Sonnet.
- **Large ngspice files (>1500 lines)**: batches 14 (`spfactor.c`, 2955), 23 (`sputils.c`, 2181), 31 (`spbuild.c`, 1207), 12 (`niiter.c`, 1096), 3A/3B (`dctran.c`, 1013). These need 2+ Read calls to cover the full file. Agent must read the whole file before any verdicts.
- **Many-source-file batches**: 3A (`dctran.c` engine layer, srcs=8), 10 (`niinteg.c`, srcs=14), 7 (`cktdefs.h`, srcs=11), 2B (`dioload.c` rest, srcs=9), 12 (`niiter.c`, srcs=9). The agent reads more digiTS files per row; needs more context budget.
- **Parallelism**: every batch is independent of every other batch — they read disjoint ngspice files (with the small bjtload/dioload/dctran sub-batch redundancy noted above) and edit disjoint inventory rows. Up to 46-way parallelism is theoretically safe; practical limits come from the orchestrator's concurrency budget and the shared-file edit contention (see "Inventory and notepad edit protocol" below).

## Inventory and notepad edit protocol

Two shared-file artifacts get updated by every batch: `spec/ngspice-citation-audit.json` (the 14k-line inventory) and `ref/ngspice/control-flow-notes.md` (the running notepad). Multiple agents editing either in parallel would trample each other's writes.

**Recommended pattern — serialised coordinator merge.** Each batch agent emits two artifacts to its per-batch report and **does not touch the shared files directly**:

1. A JSON patch list — array of `{id, status, claimKeyword, notes, ngspicePath?}` objects, one per row in the batch — that the coordinator applies to `spec/ngspice-citation-audit.json` after the wave completes.
2. The "File understanding" section(s) for each ngspice file the agent owns. The coordinator merges these into the appropriate top-level sections of `ref/ngspice/control-flow-notes.md`.

After a wave completes, the coordinator runs a single merge pass:

- Apply all JSON patches to the inventory in one transaction; re-run the citation-audit tests.
- For each ngspice file in the wave, locate the existing section in `ref/ngspice/control-flow-notes.md` (or create a new one if absent) and replace its contents with the agent's authored section. For sub-batches that share an ngspice file (1A/1B, 2A/2B, 3A/3B), take the union of the two authored sections, deduplicating bullet points and flagging any substantive disagreement for user review before merging.

This pattern avoids file-lock contention, produces a reviewable per-wave changelog, and preserves each agent's authored content verbatim. Batch agents themselves never write to either shared artifact; the coordinator owns those writes.

## Test contract

The verification batches do not introduce new tests — they tighten the existing inventory tests by populating data that those tests already check. After each batch lands:

- `InventoryStructure::verifiedRowsResolve` — every newly-verified row's `claimKeyword` must literally appear in the cited range (or whole file for file-only cites).
- `InventoryStructure::staleRowsHaveCorrection` — every newly-stale row's `notes` must contain a `<file>:<range>` substring.
- `InventoryStructure::statusEnumValid` — every row's status remains one of the four enum values.
- `InventoryStructure::idsUnique` — no row IDs are reassigned.
- `InventoryStructure::everyCitationCovered` — no source-side citations are introduced or dropped without a matching inventory row update.

Per-file completion tests (`DcopCitations::*`, `NewtonRaphsonCitations::*`, `AnalogTypesCitations::*`, etc.) flip from red to green as the relevant batches complete:

- `dc-operating-point.ts` rows are owned by batch 9 (`cktop.c`) plus a few in batches 7 (`cktdefs.h`), 27 (`cktinit.c`), C1 (`cktntask.c` / `cktncdump.c`).
- `newton-raphson.ts` rows are owned by batch 12 (`niiter.c`) plus a few in 16 (`devsup.c`), 7 (`cktdefs.h`).
- `analog-types.ts` rows are owned by batch 7 (`cktdefs.h`) plus a few in 15 (`nicomcof.c`), C1 (`cktntask.c`).

A row can only flip to `verified` when the batch covering its `ngspicePath` runs, so the per-file completion tests turn green incrementally.

## Acceptance for "all batches complete"

- Every inventory row has `status ∈ {verified, missing, stale}` (no `unverified`).
- Every `verified` row has a non-empty `claimKeyword` that literally appears in the cited line range or file.
- Every `stale` row has a `<file>:<range>` proposed correction in `notes`.
- Every `missing` row has empty `ngspicePath` and a reason in `notes`.
- Per-batch reports exist at the configured report paths and follow the report format.
- `ref/ngspice/control-flow-notes.md` exists and contains one section per ngspice file the verification batches covered. Each section follows the schema in the per-batch template's "File understanding" subsection.
- All `InventoryStructure::*` tests pass.
- All per-file completion tests pass for files whose ngspice owners have all completed (`AnalogTypesCitations::allVerified`, `DcopCitations::allInventoryVerifiedOrMissing`, `NewtonRaphsonCitations::allInventoryVerifiedOrMissing`).
- A user-side review pass has read every batch's "Surfaced divergences" section and decided whether each is a source bug, a spec amendment, or an `architectural-alignment.md` entry. Until that review happens, the unverified rows in those sections remain unverified — they do **not** auto-flip to verified after agent completion.

## Maintenance

After all batches complete:
- Re-generate the "Priority corrections" sub-table in `spec/ngspice-citation-audit.md` from the JSON.
- Update `spec/progress.md` with one entry per batch (file lists, row counts before/after, surfaced divergences count).
- `ref/ngspice/control-flow-notes.md` is durable — it survives across phases. When future work corrects a misunderstanding of an ngspice file's behaviour, the relevant notepad section is updated as part of that fix. Do not regenerate the notepad from scratch — keep edit history visible.
- The maintenance protocol in `spec/ngspice-citation-audit.md` continues to apply: agents may not flip `unverified → verified` outside of an authorised verification batch (this spec) or Phase 9.1.2's sample-audit lane.

## Out of scope

- Editing `src/**/*.ts` or anything under `ref/ngspice/src/`. Verification batches are pure documentation work; the only writable target outside `spec/` is `ref/ngspice/control-flow-notes.md` (and only by the coordinator during merge, not by individual batch agents).
- Numerical re-runs of the engine. The harness comparison work lives in Phase 10, not here.
- Adding new tests. The existing `citation-audit.test.ts` tests are sufficient; this spec only populates the data they check.
- Replacing or restructuring `spec/ngspice-citation-audit.json`. The schema is fixed. Agents only update row fields.
