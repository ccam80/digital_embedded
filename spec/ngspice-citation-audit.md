# ngspice Citation Audit

**Generated**: 2026-04-25
**Scope**: `src/**/*.ts` code-comment citations naming ngspice source files (`*.c` or `*.h` under `ref/ngspice/`)
**Inventory**: `spec/ngspice-citation-audit.json` (machine-readable single source of truth)

---

## Purpose

ngspice citations in code comments are untrusted until verified against the vendored copies under `ref/ngspice/`. This document is the verification record. It implements the I2 policy from `spec/architectural-alignment.md`: every `// cite: <file>.c:NNN` comment must describe the code that immediately follows; decorative citations are forbidden.

The JSON sidecar (`spec/ngspice-citation-audit.json`) is the authoritative row-level inventory. This document provides human-readable context, a priority-correction sub-table generated from the JSON, and the durable maintenance protocol. Do not author inventory rows here.

---

## Status definitions

| Status | Meaning |
|--------|---------|
| `verified` | Cited range inspected against `ref/ngspice/` AND the content at those lines matches the claim keyword |
| `stale` | Cited range resolves to content that does NOT match the claim; `notes` contains a proposed corrected citation |
| `unverified` | Row authored but not yet compared against `ref/ngspice/`; agents may write this value |
| `missing` | Citation incomplete — no line range, or the ngspice file does not exist in `ref/ngspice/` |

---

## Inventory

The inventory lives in the JSON sidecar alongside this file. Do not author inventory rows here.

See `spec/ngspice-citation-audit.json` for the full per-citation catalogue (1284 rows as of this audit pass). The JSON contains `id`, `sourceFile`, `sourceLine`, `ngspiceRef`, `ngspicePath`, `claim`, `claimKeyword`, `status`, and `notes` for every citation occurrence found in `src/**/*.ts`.

**Summary by status (Wave 8.1 audit pass)**:

| Status | Count |
|--------|-------|
| `verified` | 0 |
| `stale` | 11 |
| `missing` | 2 |
| `unverified` | 1271 |
| **Total** | **1284** |

---

## Priority corrections

The following rows have `status: stale` and are flagged for correction in Wave 8.2. Sorted by severity: content-mismatch (wrong file/function) ranked above line-number drift ranked above off-by-one.

| ID | Source file:line | As cited | Proposed correction | Notes |
|----|-----------------|----------|---------------------|-------|
| C-0989 | `src/solver/analog/dc-operating-point.ts:253` | `cktop.c:546` | `cktncdump.c:1` | CKTncDump function lives in cktncdump.c, not cktop.c:546 |
| C-0997 | `src/solver/analog/dc-operating-point.ts:451` | `cktop.c:546` | `cktncdump.c:1` | Same wrong-file citation as C-0989 |
| C-1062 | `src/solver/analog/newton-raphson.ts:514` | `niiter.c:204-229` | `niiter.c:1020-1046` | Lines 204-229 in vendored niiter.c are instrumentation; Newton damping block is at 1020-1046 |
| C-1047 | `src/solver/analog/newton-raphson.ts:289` | `niiter.c:37-38` | `niiter.c:622` | maxIter floor is at line 622 in vendored file; lines 37-38 are typedef struct fields |
| C-1065 | `src/solver/analog/newton-raphson.ts:600` | `niiter.c:1074` | `niiter.c:1073-1075` | Line 1073 is NISHOULDREORDER set; 1074 is mode write; should cite full MODEINITTRAN branch |
| C-1001 | `src/solver/analog/dc-operating-point.ts:529` | `cktop.c:179` | `cktop.c:183` | continuemode write at :183 in vendored file |
| C-1013 | `src/solver/analog/dc-operating-point.ts:701` | `cktop.c:381` | `cktop.c:380` | firstmode write at :380 |
| C-1014 | `src/solver/analog/dc-operating-point.ts:709` | `cktop.c:370-385` | `cktop.c:408` | zero-source NIiter call at :408 |
| C-1015 | `src/solver/analog/dc-operating-point.ts:718` | `cktop.c:386-418` | `cktop.c:413-458` | bootstrap block starts at :413 |
| C-1018 | `src/solver/analog/dc-operating-point.ts:747` | `cktop.c:420-424` | `cktop.c:385-387` | stepping params initialized at :385-387 |
| C-1032 | `src/solver/analog/newton-raphson.ts:66` | `devsup.c:49-84` | `devsup.c:50-82` | post-D4 body extends to :82; original spec cited devsup.c:50-58 |

---

## Maintenance protocol

- Agents MAY add rows with `status: unverified` when landing a new citation. Agents MUST NOT author rows with `status: verified` — only a user action or the Phase 9.1.2 sample-audit lane may mark a row verified.
- No periodic rot detection is required. Citations age silently between phase-boundary audits. The audit lanes are Phase 9.1.2 (random-sample verification) and this-phase full-file sweeps (Wave 8.2).
- This inventory catalogues `src/` code-comment citations ONLY. Citations inside `spec/` and `docs/` are out of scope.
