# Phase 8: F6 — Documentation & Citation Audit

## Overview

Pure documentation work. No runtime behavior change. Delivers:

1. A new durable inventory at `spec/ngspice-citation-audit.json` listing
   every ngspice citation in `src/` code comments with a status enum.
2. A companion `spec/ngspice-citation-audit.md` prose doc that explains
   the inventory, defines the status vocabulary, lists priority
   corrections, and records the maintenance protocol.
3. Citation corrections in the three priority files (`dc-operating-
   point.ts`, `newton-raphson.ts`, `analog-types.ts`) per the
   enumerated rot lists below plus any additional rot surfaced by the
   file-level sweep.

The JSON sidecar is the machine-readable single source of truth; the
markdown is human-readable context. Tests parse the JSON directly.

Running Phase 8 earlier would risk stale line-number citations — this
phase must run after Phases 5, 6, 7 land their final `load()` rewrites
so the citations it writes reflect the final code state.

## Governing Rules (apply to every task in this phase)

- **Source of truth for citation verification:** the current state of
  files under `ref/ngspice/`. Citations must resolve against the
  vendored copy as it exists at phase execution, not against an
  external upstream ngspice.
- **CLAUDE.md citation rule:** every `// cite: xxxload.c:NNN` comment
  must describe the code that immediately follows. Decorative citations
  are forbidden.
- **Banned closing verdicts apply:** *mapping*, *tolerance*, *close
  enough*, *equivalent to*, *pre-existing*, *intentional divergence*,
  *citation divergence*, *partial* may not be used to close any
  citation-audit finding. If a cite cannot be resolved, STOP and
  escalate — do not paper over.

## Wave 8.1: Spec artifact

### Task 8.1.1: Create citation-audit inventory (JSON sidecar + markdown companion)

- **Description**: Create the durable inventory of every ngspice
  citation in `src/` code comments, split into a machine-readable JSON
  sidecar and a human-readable markdown companion. The JSON is the
  source of truth; the markdown explains it.
- **Files to create**:
  - `spec/ngspice-citation-audit.json` — machine-readable inventory.
    Schema below.
  - `spec/ngspice-citation-audit.md` — markdown companion. Sections:
    purpose, status definitions, pointer to the JSON sidecar, priority
    corrections sub-table, maintenance protocol.
- **Files to modify**: (none)
- **Inventory scope**:
  - Every code-comment citation in `src/**/*.ts` that names an ngspice
    source file (`*.c` or `*.h` under `ref/ngspice/`) with or without
    a line-number range. Includes `// cite:` comments, `ngspice` prose
    mentions that name a file, `Matches ngspice X` phrasings, and
    variable-mapping tables that list ngspice file references.
  - `spec/` files and `docs/` files are OUT OF SCOPE. Only citations
    in `src/` code comments count.

- **JSON schema** (`spec/ngspice-citation-audit.json`):
  ```
  {
    "schemaVersion": 1,
    "generatedAt": "<ISO-8601 UTC timestamp>",
    "statusDefinitions": {
      "verified":   "cited range inspected against ref/ngspice/ AND the content at those lines matches the claim keyword",
      "stale":      "cited range resolves to content that does NOT match the claim; notes contain a proposed corrected citation",
      "unverified": "row authored but not yet compared against ref/ngspice/; agents may write this value",
      "missing":    "citation incomplete (no line range, or the ngspice file does not exist in ref/ngspice/)"
    },
    "rows": [
      {
        "id": "C-001",
        "sourceFile": "src/solver/analog/dc-operating-point.ts",
        "sourceLine": 16,
        "ngspiceRef": "cktntask.c:103",
        "ngspicePath": "ref/ngspice/src/spicelib/analysis/cktntask.c",
        "claim": "CKTgminFactor default 10",
        "claimKeyword": "TSKgminFactor",
        "status": "verified",
        "notes": ""
      }
      // ... one object per citation occurrence
    ]
  }
  ```

- **Required fields per row**:
  - `id` — stable `"C-NNN"` identifier assigned in row order. Never
    reused once deleted.
  - `sourceFile` — digiTS path relative to repo root, forward slashes.
  - `sourceLine` — 1-based line of the citation occurrence.
  - `ngspiceRef` — the citation text exactly as it appears (e.g.
    `"cktop.c:127-258"`, `"devsup.c:50-82"`).
  - `ngspicePath` — resolved path under `ref/ngspice/`. Empty string if
    `status === "missing"` and the file cannot be located.
  - `claim` — one-line paraphrase of what the comment claims.
  - `claimKeyword` — a short string (function name, macro, or
    distinctive symbol like `NISHOULDREORDER`, `TSKgminFactor`) that
    must appear literally in the cited ngspice range for the row to be
    `verified`. Populated by the row author; blank allowed for
    `status: unverified` / `missing`.
  - `status` — exactly one of `verified`, `stale`, `unverified`,
    `missing`.
  - `notes` — free text. Required non-empty when `status !== "verified"`.
    For `stale`, contains a proposed corrected citation in the form
    `"<file>:<range>"`.

- **Markdown companion structure** (`spec/ngspice-citation-audit.md`):
  1. **Purpose** — two-paragraph prose restating I2 policy from
     `architectural-alignment.md`: ngspice citations in code comments
     are untrusted until verified; this doc is the verification record.
  2. **Status definitions** — the four-value table (matches the JSON
     `statusDefinitions` object verbatim).
  3. **Inventory** — points to `spec/ngspice-citation-audit.json` as
     the authoritative list. Says "The inventory lives in the JSON
     sidecar alongside this file. Do not author inventory rows here."
  4. **Priority corrections** — a markdown sub-table enumerating all
     rows with `status: stale`, sorted by severity (content mismatch
     ranked above line-number drift ranked above off-by-one). Each
     entry lists `id`, `sourceFile:sourceLine`, `ngspiceRef` as-cited,
     and the proposed correction from the row's `notes`. The
     implementer re-generates this table from the JSON at commit time;
     it does not need to be kept in sync by hand.
  5. **Maintenance protocol** — the three rules below, verbatim:
     - Agents MAY add rows with `status: unverified` when landing a
       new citation. Agents MUST NOT author rows with
       `status: verified` — only a user action or the Phase 9.1.2
       sample-audit lane may mark a row verified.
     - No periodic rot detection is required. Citations age silently
       between phase-boundary audits. The audit lanes are Phase 9.1.2
       (random-sample verification) and this-phase full-file sweeps
       (Wave 8.2).
     - This inventory catalogues `src/` code-comment citations ONLY.
       Citations inside `spec/` and `docs/` are out of scope.

- **Tests** (all parse the JSON sidecar; the markdown is not machine-
  validated except for existence):
  - `src/solver/analog/__tests__/citation-audit.test.ts::InventoryStructure::schemaLoads`
    — assert `spec/ngspice-citation-audit.json` exists, parses as
    JSON, has the top-level keys `schemaVersion`, `generatedAt`,
    `statusDefinitions`, `rows`.
  - `src/solver/analog/__tests__/citation-audit.test.ts::InventoryStructure::markdownCompanionExists`
    — assert `spec/ngspice-citation-audit.md` exists and contains the
    strings `"Status definitions"`, `"Inventory"`, `"Priority
    corrections"`, `"Maintenance protocol"`.
  - `src/solver/analog/__tests__/citation-audit.test.ts::InventoryStructure::rowFieldsPresent`
    — assert every row has non-empty string values for `id`,
    `sourceFile`, `ngspiceRef`, `claim`, `status`, and an integer
    `sourceLine` ≥ 1.
  - `src/solver/analog/__tests__/citation-audit.test.ts::InventoryStructure::statusEnumValid`
    — assert every row's `status` is exactly one of the four enum
    values defined in `statusDefinitions`.
  - `src/solver/analog/__tests__/citation-audit.test.ts::InventoryStructure::staleRowsHaveCorrection`
    — assert every `status: stale` row has a non-empty `notes`
    containing a substring matching the regex
    `/[a-zA-Z_0-9]+\.(c|h):\d+(-\d+)?/` (a proposed corrected
    citation).
  - `src/solver/analog/__tests__/citation-audit.test.ts::InventoryStructure::verifiedRowsResolve`
    — for every `status: verified` row, assert `ngspicePath` is a
    real file under `ref/ngspice/` AND the cited line range is within
    the file's total line count AND the `claimKeyword` string appears
    literally inside the cited line range.
  - `src/solver/analog/__tests__/citation-audit.test.ts::InventoryStructure::idsUnique`
    — assert no two rows share the same `id`.
  - `src/solver/analog/__tests__/citation-audit.test.ts::InventoryStructure::everyCitationCovered`
    — scan `src/**/*.ts` for the regex
    `/[a-zA-Z_0-9]+\.(c|h):\d+(-\d+)?/` (in comment lines only), and
    assert every match has at least one row in the inventory whose
    `(sourceFile, sourceLine, ngspiceRef)` triple matches. Inverse
    direction only (no citation is uncovered) — duplicate rows for
    the same citation are acceptable if the citation text appears on
    multiple lines.

- **Acceptance criteria**:
  - `spec/ngspice-citation-audit.json` exists and validates against
    the schema.
  - `spec/ngspice-citation-audit.md` exists and contains the five
    sections above in order.
  - Every code-comment citation in `src/**/*.ts` matching the
    `<file>.(c|h):NNN` form has at least one row in the JSON.
  - Every row has populated the required fields.
  - Every row's `status` is one of the four enum values.
  - Every `stale` row has a proposed correction in `notes`.
  - Every `verified` row's `claimKeyword` appears in the cited range.
  - The seven citation-audit tests above pass.

## Wave 8.2: Citation corrections in source

Each task below identifies specific rotten citations to correct. Before
editing, the implementer re-runs a cite-resolution sweep on the file
using `ref/ngspice/` as ground truth; any additional rot surfaced
during the sweep is corrected in the same commit and the inventory
rows are updated (`stale` → `verified` for corrected cites; new rows
added if the sweep discovers cites that were not in the original
inventory).

### Task 8.2.1: `dc-operating-point.ts` citation corrections

- **Description**: Correct the enumerated rotten citations in
  `src/solver/analog/dc-operating-point.ts` against `ref/ngspice/`,
  plus any additional rot surfaced during the file-level sweep. No
  runtime behavior changes.
- **Files to create**: (none)
- **Files to modify**:
  - `src/solver/analog/dc-operating-point.ts` — correct stale
    citations per the enumerated list below plus sweep findings.
  - `spec/ngspice-citation-audit.json` — update affected rows from
    `stale` to `verified` after correction.
- **Enumerated corrections** (identified during spec authoring against
  the current `ref/ngspice/src/spicelib/analysis/cktop.c` vendored
  copy):

  | # | `dc-operating-point.ts` line | As cited | Actual | Fix |
  |---|------------------------------|---------|--------|-----|
  | 1 | 536 (inside `dynamicGmin` success branch) | `cktop.c:179 continuemode=MODEINITFLOAT` | `ckt->CKTmode = continuemode;` sits at `cktop.c:183` | `cktop.c:183` |
  | 2 | 708 (inside `gillespieSrc`, after zeroState) | `cktop.c:381 firstmode=MODEINITJCT` | `ckt->CKTmode = firstmode;` sits at `cktop.c:380` | `cktop.c:380` |
  | 3 | 65 (scaleAllSources docstring) | `cktop.c:385 (gillespie_src start — ckt->CKTsrcFact = 0;)` | `ckt->CKTsrcFact = 0;` sits at `cktop.c:384` | `cktop.c:384` |
  | 4 | 716 (inside `gillespieSrc` before first NR) | `cktop.c:370-385: zero-source NR solve` | Lines 370-385 are function signature + variable declarations. The zero-source NIiter call is at `cktop.c:~406`. | `cktop.c:406` (narrow to the NIiter call site) |
  | 5 | 725 (inside `gillespieSrc` bootstrap fallback) | `cktop.c:386-418: gmin bootstrap for zero-source circuit` | Bootstrap block starts at `cktop.c:408` (the `if (converged != 0)` fallback) and runs through `~:460`. | `cktop.c:408-460` |
  | 6 | 754 (inside `gillespieSrc` before main loop) | `cktop.c:420-424: initialise stepping parameters` | Stepping params (`srcFact=0; raise=0.001; ConvFact=0`) are initialised at `cktop.c:384-386`. | `cktop.c:384-386` |
  | 7 | 253 (cktncDump header) and 458 (Level-5 failure block) | `cktop.c:546+` for "non-convergence diagnostics" | Line 546 sits inside the tail of `gillespie_src`. `CKTncDump` lives in a different file: `ref/ngspice/src/spicelib/analysis/cktncdump.c`. | Re-cite to `cktncdump.c` (entire file — it's one function; no line range needed) |
  | 8 | Multiple (lines 10, 690, 694) | `cktop.c:354-546` as the gillespie_src range | `gillespie_src` function runs from `cktop.c:368` (static int decl) through `~:577` (closing brace). Range `:354-546` truncates ~30 lines early. | `cktop.c:368-577` |

- **Sweep scope** (implementer applies on top of the enumerated list):
  - Every occurrence of the substrings `cktop.c`, `dcop.c`,
    `dctran.c`, `niiter.c`, `cktntask.c`, `vsrcload.c`, `isrcload.c`,
    `cktdefs.h`, `spsmp.c`, `spfactor.c`, `devsup.c` — resolve the
    cited line range against `ref/ngspice/`, confirm the `claimKeyword`
    (or the comment's paraphrased claim) appears literally at that
    range, correct any mismatch.
  - Inventory rows for `src/solver/analog/dc-operating-point.ts` are
    updated: `stale` rows flip to `verified` once the correction is
    landed and re-inspected.

- **Tests**:
  - `src/solver/analog/__tests__/citation-audit.test.ts::DcopCitations::enumeratedCorrectionsLanded`
    — parse the inventory rows whose `sourceFile ===
    "src/solver/analog/dc-operating-point.ts"` and
    `sourceLine ∈ {65, 253, 458, 536, 708, 716, 725, 754}` (and every
    sourceLine that originally cited `cktop.c:354-546`); assert each
    row's `status === "verified"` and `ngspiceRef` matches the Fix
    column above.
  - `src/solver/analog/__tests__/citation-audit.test.ts::DcopCitations::allInventoryVerifiedOrMissing`
    — parse every inventory row whose `sourceFile` is the dc-
    operating-point file and assert no row has `status === "stale"` —
    every one is either `verified` or (if the citation names a file
    not in `ref/ngspice/`) `missing`.
  - Existing `src/solver/analog/__tests__/dc-operating-point.test.ts`
    suite — still passes (no runtime behavior change).
- **Acceptance criteria**:
  - All eight enumerated corrections landed.
  - Every ngspice citation in the file resolves against `ref/ngspice/`.
  - The dc-operating-point inventory rows are all `status: verified`
    or `missing` (none `stale`).
  - Existing dc-operating-point test suite passes unchanged.

### Task 8.2.2: `newton-raphson.ts` citation corrections

- **Description**: Correct the enumerated rotten citations in
  `src/solver/analog/newton-raphson.ts` against `ref/ngspice/`, plus
  any additional rot surfaced during the sweep.
- **Files to create**: (none)
- **Files to modify**:
  - `src/solver/analog/newton-raphson.ts` — correct stale citations.
  - `spec/ngspice-citation-audit.json` — update affected rows.
- **Enumerated corrections** (identified during spec authoring):

  | # | Line | As cited | Problem | Fix |
  |---|------|---------|---------|-----|
  | 1 | 67 (pnjlim docstring) | `devsup.c:50-58` | pre-D4 range; post-D4 pnjlim body (with the Gillespie negative-bias branch) extends through line 82 | `devsup.c:50-82` |
  | 2 | 272 | `niiter.c:37-38 — unconditional floor: if (maxIter < 100) maxIter = 100;` | Lines 37-38 of `ref/ngspice/src/maths/ni/niiter.c` are inside a typedef struct. The maxIter floor is elsewhere in the vendored file. | Implementer locates the actual maxIter floor in the vendored file and writes the correct line range |
  | 3 | 498 | `STEP I: Newton damping (ngspice niiter.c:204-229)` | Lines 204-229 of the vendored file are instrumentation code (`ni_limit_record`, `ni_get_dev_index`), not the Newton damping block. | Implementer locates the actual Newton damping block in the vendored file and writes the correct line range |
  | 4 | 584 | `Here we only mirror niiter.c:1074 — clear MODEINITTRAN and set MODEINITFLOAT` | In the vendored file, line 1074 is the `NISHOULDREORDER` set (`if(iterno<=1) ckt->CKTniState \|= NISHOULDREORDER;`); the mode write is at line 1075. | `niiter.c:1075` (for just the mode write) or `niiter.c:1073-1075` (for the full MODEINITTRAN branch) |

- **Plan-referenced targets that do NOT exist in the current file and
  therefore require no edit here:** `cktntask.c:97`,
  `niiter.c:1012-1046`. The plan text is stale on these two; confirm
  their absence in the sweep and do not invent edits.

- **Sweep scope** (implementer applies on top of the enumerated list):
  - Every occurrence of `devsup.c`, `niiter.c`, `dctran.c`,
    `cktdefs.h`, `spsmp.c` in a code comment — verify range against
    `ref/ngspice/`, correct mismatches. Note that the vendored
    `niiter.c` has instrumentation added (`ni_instrument_cb`,
    `NI_MAX_LIMIT_EVENTS`, etc.) that shifts line numbers relative to
    upstream ngspice; the vendored file is the source of truth.
- **Tests**:
  - `src/solver/analog/__tests__/citation-audit.test.ts::NewtonRaphsonCitations::enumeratedCorrectionsLanded`
    — for the four rows with `sourceLine ∈ {67, 272, 498, 584}` in
    `src/solver/analog/newton-raphson.ts`, assert each is
    `status: verified` and `ngspiceRef` matches the Fix column.
  - `src/solver/analog/__tests__/citation-audit.test.ts::NewtonRaphsonCitations::allInventoryVerifiedOrMissing`
    — every newton-raphson inventory row is `verified` or `missing`;
    none `stale`.
  - Existing `src/solver/analog/__tests__/newton-raphson.test.ts`
    suite — still passes (no runtime behavior change).
- **Acceptance criteria**:
  - The four enumerated rotten citations are corrected.
  - Every ngspice citation in the file resolves against `ref/ngspice/`
    with exact function-name / control-flow-pattern match at the
    cited range.
  - Inventory rows for this file are all `verified` or `missing`.
  - Existing newton-raphson test suite passes unchanged.

### Task 8.2.3: `analog-types.ts` citation correction

- **Description**: The plan's nominal target (`niiter.c:991-997` on
  line 82) does not exist anywhere under `src/`. Task is SATISFIED by
  absence — no source edit required. Inventory rows for this file are
  promoted to `verified` if their claim keyword matches the cited
  range.
- **Files to create**: (none)
- **Files to modify**:
  - `spec/ngspice-citation-audit.json` — update
    `src/core/analog-types.ts` rows from `unverified` to `verified`
    after sweep confirms each cite's claim keyword at the cited range.
- **Verification** (implementer runs to confirm the SATISFIED-by-
  absence finding before closing the task):
  - Repo-wide grep under `src/` for the literal `niiter.c:991-997`
    returns zero matches.
  - Every ngspice citation in `src/core/analog-types.ts` resolves
    against `ref/ngspice/`. At spec-authoring time the only such
    citations were `cktdefs.h:177-182` (line 85) and
    `bjtload.c:265-274` (line 215); both were spot-verified.
- **Tests**:
  - `src/solver/analog/__tests__/citation-audit.test.ts::AnalogTypesCitations::allVerified`
    — every inventory row with `sourceFile === "src/core/analog-types.ts"`
    has `status === "verified"`.
  - `src/solver/analog/__tests__/citation-audit.test.ts::PlanTargetRotAbsent::noStaleNiiter991`
    — grep for `niiter.c:991-997` under `src/` returns zero matches.
- **Acceptance criteria**:
  - Grep for `niiter.c:991-997` under `src/` returns zero matches.
  - Every citation in `src/core/analog-types.ts` resolves against
    `ref/ngspice/`.
  - All `analog-types.ts` inventory rows are `status: verified`.
  - Both citation-audit tests above pass.

## Commit

One commit for the whole phase:
`Phase 8 — F6 citation audit + corrections`.
