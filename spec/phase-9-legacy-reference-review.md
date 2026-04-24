# Phase 9: Legacy Reference Review + Full Suite Run

## Overview

Final audit before the Phase 10 acceptance gate. Three tasks:

1. Re-run Phase 0's identifier grep sweep repo-wide, confirming zero
   hits outside `ref/ngspice/` and `spec/`.
2. Random-sample ten ngspice citations from `src/` and verify each
   against `ref/ngspice/` with exact function/pattern matching; expand
   scope on finding rot.
3. Run the full test suite to completion and snapshot failures as the
   Phase 10 acceptance input — no fix-chasing in this phase.

Phase 9 is a baseline-capture phase, not a fix-landing phase. Its
output is:
- Confirmation that the Phase 0 identifier list is still zero-hit.
- A citation-audit sub-result that either promotes 10 inventory rows
  to `status: verified` OR triggers scope expansion into the file(s)
  where rot was found.
- A durable JSON snapshot of full-suite test failures handed off to
  Phase 10.

Phase 9 is "done" when all three tasks have run to completion. Test
failure count is NOT a gate — Phase 10 triages failures. Governing
principle 6 from `spec/plan.md` applies: full-suite passage becomes a
gate at Phase 9.1.3, meaning 9.1.3 must *run to completion*, not
*pass*.

## Governing Rules (apply to every task in this phase)

- **No fix-chasing.** If 9.1.3 surfaces test failures, do not attempt
  repairs in Phase 9. Snapshot and hand off.
- **No scope narrowing.** If 9.1.2's sample finds rot, expand into the
  containing file and audit every citation in that file — do not
  truncate at "ten citations" once rot is surfaced.
- **Banned closing verdicts apply.** A stale citation is not closed by
  declaring it *pre-existing* or *citation divergence*. It is fixed in
  place or escalated.

## Wave 9.1: Full audit

### Task 9.1.1: Repo-wide identifier grep

- **Description**: Re-run Phase 0's identifier list verbatim as a
  repo-wide grep. The authoritative list is the one defined in
  `spec/plan.md` Wave 0.1.1. Phase 9 does NOT consume a dynamically
  built list; if Phases 3–8 identified new Track-A-deleted symbols,
  those should have been added to Phase 0's list retroactively in
  `spec/plan.md` before Phase 9 runs. Phase 9 reads the list as it
  stands in `spec/plan.md` at phase start.
- **Files to create**:
  - `test-results/phase-9-identifier-sweep.json` — durable snapshot of
    the sweep result. Schema below.
- **Files to modify**: (none)
- **Snapshot schema** (`test-results/phase-9-identifier-sweep.json`):
  ```
  {
    "capturedAt": "<ISO-8601 UTC timestamp>",
    "listSource": "spec/plan.md Wave 0.1.1 (read at phase start)",
    "identifiers": [
      {
        "identifier": "<string>",
        "hitCount": <int>,
        "hitsOutsideAllowlist": <int>,
        "allowlist": ["ref/ngspice/", "spec/"],
        "offendingPaths": ["<path>", ...]
      }
    ]
  }
  ```
- **Expected result**:
  - Every identifier has `hitsOutsideAllowlist: 0`.
  - `offendingPaths` is empty for every identifier.
- **On non-zero offending paths**: STOP and escalate. Do not delete
  the residue — Phase 0 / Phase 2.5 are the deletion lanes and their
  closure claim is what Phase 9 is verifying. Residue at this phase
  means an earlier phase's closure claim was incomplete.
- **Tests**:
  - `src/solver/analog/__tests__/phase-9-sweep.test.ts::IdentifierSweep::snapshotExists`
    — assert `test-results/phase-9-identifier-sweep.json` exists and
    parses as valid JSON against the schema above.
  - `src/solver/analog/__tests__/phase-9-sweep.test.ts::IdentifierSweep::allZeroOffendingPaths`
    — assert every identifier row has `hitsOutsideAllowlist === 0`.
- **Acceptance criteria**:
  - Snapshot JSON exists and validates against the schema.
  - Every identifier in the snapshot has zero offending paths.
  - Both tests above pass.

### Task 9.1.2: Citation sample audit (random, exact, expand-on-rot)

- **Description**: Draw a literal random sample of ten ngspice
  citations from `src/**/*.ts` code comments. **For each sampled
  citation, an agent or user performs a manual ref-check** against
  `ref/ngspice/` using exact function and pattern matching. The
  manual verdict (plus supporting notes) is recorded in a JSON
  snapshot. On discovering rot in any sampled citation, the scope
  expands to audit every citation in the containing file (again
  manually) and corrections are landed in source.

  **Nothing in this task is automatically verified by test code.**
  The test suite only checks that the snapshot artifact is well-
  formed and internally consistent — it does NOT re-do the manual
  verification. The tests below are artifact-hygiene checks, not
  truth checks. Verifying that the recorded verdicts are themselves
  correct is a human review responsibility (spot-check during user
  review of the commit).
- **Files to create**:
  - `test-results/phase-9-citation-sample.json` — durable snapshot
    holding the sample, the verdicts, the scope-expansion records,
    and the correction count.
- **Files to modify**:
  - `spec/ngspice-citation-audit.json` — rows for sampled citations
    transition from `unverified` to `verified` or `stale`. When
    scope-expansion triggers, rows for the expanded file also
    transition.
  - Source files where rot was found are corrected in place.

- **Sampling methodology** (performed once by the audit agent):
  - Source population: the list of all citation occurrences in
    `spec/ngspice-citation-audit.json` — one population-member per
    row.
  - Sample mechanism: literal random — Node.js
    `crypto.randomInt(0, population.length)` drawn ten times without
    replacement. Seeded / deterministic runs are NOT permitted; the
    sample must be genuinely random so repeat audits spread coverage.
  - Sample size: exactly ten citations (unless the population
    contains fewer than ten total, in which case the full population
    is sampled).
  - The audit agent records the selected row IDs in the snapshot's
    `samples[].inventoryRowId` field before performing the
    verification — the sample is frozen before the verification pass
    so the snapshot is reproducible as a historical record (even
    though the sample itself was non-deterministic at generation
    time).

- **Manual verification per sampled citation** (performed by the
  audit agent — no code automates this):
  1. Open the ngspice file at the cited range in `ref/ngspice/`.
  2. Read the cited lines.
  3. Match the citation's `claim` paraphrase (and `claimKeyword`
     field from the inventory row) against the content of those
     lines. A citation passes iff EITHER the named function/macro
     definition starts within the range, OR the described control-
     flow pattern appears literally in the range. Line ranges that
     overlap but do not contain the described code fail.
  4. Record the verdict in the snapshot as `"verified"` or
     `"stale"`, with free-text `notes` summarizing what was found.
     For `stale` verdicts, `notes` MUST include a proposed corrected
     citation in `"<file>:<range>"` form.

- **Expand-on-rot rule** (performed by the audit agent):
  - If any sampled citation fails verification, the audit expands to
    the containing `src/` file: every citation in that file is
    verified against `ref/ngspice/` using the same exact-match rule.
    Rot surfaced during expansion is corrected in the same commit.
  - Expansion is NOT transitive. If the expanded file references
    other `src/` files' cites, the audit does not cross those
    boundaries — they go back into the normal random-sample pool
    for future audits.
  - The expansion is recorded in the snapshot's `expansions[]` array
    with the trigger row, the expanded file path, a count of
    citations audited during expansion, a count of new `stale` cites
    found, and a count of corrections landed in this phase.
    `newStaleFound === correctionsLanded` is the invariant: every
    rot found during expansion gets fixed in Phase 9, because
    Phase 9 only runs after Phase 8 (where the full-file sweeps
    landed) and a rot-surfacing expansion means Phase 8's sweep
    missed it.

- **Snapshot schema** (`test-results/phase-9-citation-sample.json`):
  ```
  {
    "capturedAt": "<ISO-8601 UTC timestamp>",
    "populationSize": <int>,
    "sampleSize": <int>,
    "samples": [
      {
        "inventoryRowId": "C-<NNN>",
        "sourceFile": "<path>",
        "sourceLine": <int>,
        "ngspiceRef": "<string>",
        "verificationResult": "verified" | "stale",
        "matchType": "function-definition" | "control-flow-pattern" | "failed",
        "notes": "<string>"
      }
    ],
    "expansions": [
      {
        "triggeredBy": "C-<NNN>",
        "expandedFile": "<path>",
        "citationsAudited": <int>,
        "newStaleFound": <int>,
        "correctionsLanded": <int>
      }
    ]
  }
  ```

- **Tests (artifact-hygiene only — NOT content verification)**:
  - `src/solver/analog/__tests__/phase-9-sweep.test.ts::CitationSample::snapshotExists`
    — assert `test-results/phase-9-citation-sample.json` exists and
    parses as valid JSON.
  - `src/solver/analog/__tests__/phase-9-sweep.test.ts::CitationSample::schemaShape`
    — assert the top-level keys match the schema and every entry in
    `samples[]` and `expansions[]` has all required fields populated
    (no nulls, no missing fields).
  - `src/solver/analog/__tests__/phase-9-sweep.test.ts::CitationSample::sizeIsTen`
    — assert `sampleSize === 10` OR
    `sampleSize === populationSize` (for small populations).
  - `src/solver/analog/__tests__/phase-9-sweep.test.ts::CitationSample::verdictEnumValid`
    — assert every `samples[].verificationResult` is either
    `"verified"` or `"stale"` (no other values).
  - `src/solver/analog/__tests__/phase-9-sweep.test.ts::CitationSample::staleRowsHaveCorrection`
    — assert every sample with `verificationResult === "stale"` has
    a `notes` string that contains a substring matching
    `/[a-zA-Z_0-9]+\.(c|h):\d+(-\d+)?/`.
  - `src/solver/analog/__tests__/phase-9-sweep.test.ts::CitationSample::expansionsBalanced`
    — internal numeric consistency check: every entry in
    `expansions[]` has
    `newStaleFound === correctionsLanded`. This asserts the recorded
    numbers are self-consistent; it does NOT assert the corrections
    were themselves correct (that remains a human review concern).
  - `src/solver/analog/__tests__/phase-9-sweep.test.ts::CitationSample::inventorySyncedForSamples`
    — for every sampled row, assert its current status in
    `spec/ngspice-citation-audit.json` matches the snapshot's
    `verificationResult`.

  **What is NOT tested**:
  - Whether the recorded `verificationResult` is actually correct
    for the sampled citation. The snapshot could record
    `"verified"` for a citation that is in fact stale, and no
    test here catches it. The only safeguards are (a) `Wave 9.1.2`
    expand-on-rot protocol surfacing rot that makes it past the
    initial sample, and (b) human review at commit time.
  - Whether corrections landed in source code actually fix the
    cited range. Once a correction lands, its inventory row
    transitions to `verified` — re-verification of that row is
    deferred to a future sample-audit pass.

- **Acceptance criteria**:
  - Ten citations (or the full population, if smaller) were
    manually audited by the phase agent with exact function/pattern
    matching per the verification protocol.
  - Snapshot JSON exists and validates against the schema.
  - Every sampled citation's `status` in
    `spec/ngspice-citation-audit.json` is updated from `unverified`
    to `verified` or `stale` (matching the snapshot).
  - Every expansion triggered by a `stale` finding completed — all
    cites in the expanded file are `verified` or `stale-with-
    correction-landed`.
  - Every correction identified during sample or expansion is
    landed in source in this phase's commit.
  - The seven artifact-hygiene tests pass.

### Task 9.1.3: Full suite run to completion

- **Description**: Execute `npm test` to completion. Capture the
  resulting test failures as a durable JSON snapshot for Phase 10
  acceptance triage. Do NOT attempt fixes. Do NOT re-run selectively
  to chase flakes; the full-suite single-run is the baseline.
- **Files to create**:
  - `test-results/phase-9-full-suite-baseline.json` — durable JSON
    snapshot of full-suite failures. Stable path for Phase 10 handoff;
    must NOT be the transient `test-results/test-failures.json` that
    `npm run test:q` overwrites.
- **Files to modify**: (none)
- **Snapshot schema** (`test-results/phase-9-full-suite-baseline.json`):
  ```
  {
    "capturedAt": "<ISO-8601 UTC timestamp>",
    "command": "npm test",
    "nodeVersion": "<string>",
    "exitCode": <int>,
    "totals": {
      "tests": <int>,
      "passed": <int>,
      "failed": <int>,
      "skipped": <int>,
      "durationMs": <int>
    },
    "failures": [
      {
        "suite": "<string>",
        "testPath": "<file>::<describe>::<it>",
        "errorMessage": "<string>",
        "stackSummary": "<string (first 20 lines)>"
      }
    ]
  }
  ```
- **Run protocol**:
  - Single invocation of `npm test`. No retries, no watch mode, no
    selective scoping.
  - Command runs to completion regardless of exit code. A non-zero
    exit code is captured in the snapshot's `exitCode` field; it does
    NOT abort the snapshot generation.
  - Output capture is full stdout + stderr. The harness parses the
    test reporter output to populate the snapshot; if the reporter
    format is ambiguous, the snapshot falls back to one `failures[]`
    entry per reported failed test name with best-effort error text.
- **No fix-chasing rule**: Phase 9.1.3 writes the snapshot and hands
  off. If a failure's root cause is obviously in-phase (e.g.
  Phase 8.2's citation edit broke a test), the implementer does NOT
  fix it here — the fix belongs to a follow-up commit against the
  originating phase's closure claim, which Phase 10 triage surfaces.
- **Tests**:
  - `src/solver/analog/__tests__/phase-9-sweep.test.ts::FullSuiteBaseline::snapshotExists`
    — assert `test-results/phase-9-full-suite-baseline.json` exists
    and validates against the schema. (This test itself runs as part
    of the baseline — the snapshot it checks is the ONE from the
    prior run; on the first run the snapshot is absent, which is the
    baseline-missing signal.)
  - `src/solver/analog/__tests__/phase-9-sweep.test.ts::FullSuiteBaseline::schemaFields`
    — assert all required schema fields are populated (no nulls in
    `command`, `exitCode`, `totals`, `failures` top-level fields).
- **Acceptance criteria**:
  - `npm test` ran to completion. `exitCode` is recorded in the
    snapshot regardless of pass/fail.
  - `test-results/phase-9-full-suite-baseline.json` exists and
    validates against the schema.
  - Snapshot is NOT the same file as the transient
    `test-results/test-failures.json`; it is a stable, phase-scoped
    artifact.
  - No test-fix commits were landed during this task — the snapshot
    is taken from a source tree identical to the one that entered the
    phase (modulo Phase 8 / Wave 9.1.1 / Wave 9.1.2 edits).

## Commit

One commit for the whole phase:
`Phase 9 — legacy reference review + full suite baseline`.
