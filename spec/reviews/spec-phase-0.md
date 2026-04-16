# Spec Review: Phase 0 — Sparse Solver Rewrite

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 3 | 3 |
| major    | 1 | 4 | 5 |
| minor    | 0 | 2 | 2 |
| info     | 2 | 0 | 2 |

## Plan Coverage
All six plan tasks for Phase 0 appear in the spec. Plan coverage complete.

## Mechanical Fixes
| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | major | §Task 0.2.1 Description | "The algorithm is detailed in the plan's Appendix C" — master plan has no Appendix C | Delete the sentence; the algorithm is already described inline below |

## Decision-Required Items

### D1 — Ambiguous scope of "persistent linked lists": stamp storage vs. Markowitz overlay (critical)
- **Location**: §Task 0.1.1
- **Problem**: Current `_rowHead`/`_colHead`/etc. are ephemeral Markowitz overlay; spec requires persistence but doesn't describe relationship to existing overlay
- **Options**: (A) Single persistent linked structure, eliminate `_buildLinkedMatrix()`; (B) Two separate structures; (C) "Persistent" means only the stamp lookup cache

### D2 — Task 0.1.3 describes a "linked L/U structure" that does not exist (critical)
- **Location**: §Task 0.1.3
- **Problem**: `_numericLUMarkowitz()` builds L/U directly into CSC; no "linked L/U structure" exists
- **Options**: (A) Introduce new persistent linked L/U; (B) Reuse existing Markowitz pool with value-index fields; (C) Spec error — delete "linked L/U" language, L/U stays in CSC

### D3 — Task 0.3.2 E_SINGULAR test "stampAll called twice" unverifiable and cross-phase ambiguous (critical)
- **Location**: §Task 0.3.2 Tests
- **Problem**: `stampAll` is deleted in Phase 2; test expectation uncertain; no spy/counter mechanism exists
- **Options**: (A) Add mock/spy seam to NROptions; (B) Test observable effect (`lastFactorUsedReorder`); (C) Defer call-count assertion to Phase 2

### D4 — Task 0.1.2 deletes `_symbolicLU()` without specifying workspace allocation replacement (major)
- **Location**: §Task 0.1.2 Files to modify
- **Problem**: `_symbolicLU()` allocates all workspace arrays. Deleting it leaves them uninitialized
- **Options**: (A) Split `_symbolicLU()`, rename to `_allocateWorkspace()`; (B) Inline allocation into `_numericLUMarkowitz()`; (C) Keep method but remove only AMD lines

### D5 — Task 0.1.1 "O(1) amortized" claim contradicts described chain-walk algorithm (major)
- **Location**: §Task 0.1.1 Acceptance criteria
- **Problem**: Walking column chain is O(k); O(1) requires cache mechanism not described
- **Options**: (A) Change API to `allocElement(row,col)` + `stampElement(handle,value)`; (B) Remove O(1) claim, state O(k) with small k; (C) Add explicit `Map<encoded_key, element_index>` cache

### D6 — No MCP or E2E test surface; Three-Surface Testing Rule not addressed (minor)
- **Location**: Phase 0 — all tasks
- **Options**: (A) Explicitly exempt Phase 0 (deferred to Phase 7 parity); (B) Add one integration-level test per wave via headless facade

### D7 — Task 0.3.1 "verify these match ngspice exactly" is prose-only with no test assertion (minor)
- **Location**: §Task 0.3.1
- **Problem**: Line number references (683, 699-700) will stale; no automated verification
- **Options**: (A) Add test assertions at each transition point; (B) Keep as prose, replace line numbers with structural description

## Info
- I1: Line numbers in Task 0.1.2 (634-681, 691-730, 732-782) will shift after Task 0.1.1 edits
- I2: Line numbers at newton-raphson.ts:530-534 in Task 0.3.2 diagnosis accurate but will drift

Full report written to: spec/reviews/spec-phase-0.md
